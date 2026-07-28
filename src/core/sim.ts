/**
 * Симуляция партии. Ровно один тик за вызов step().
 *
 * Ограничения, которые нельзя нарушать:
 *  - никакого Math.random(), Date.now(), обращений к DOM;
 *  - порядок обработки внутри тика фиксирован;
 *  - весь ввод приходит только командами.
 * Иначе рассыплются реплеи, сверка по сети и автотесты баланса.
 */

import {
  AURA_DAMAGE_PER_LEVEL,
  AURA_RADIUS_BASE,
  AURA_RADIUS_PER_LEVEL,
  AURA_RANGE_PER_LEVEL,
  AURA_RATE_PER_LEVEL,
  BURN_DAMAGE_SHARE,
  BURN_SECONDS,
  BURN_UPGRADE_LEVEL,
  BURN_UPGRADE_SHARE,
  CHAIN_FALLOFF,
  CHAIN_RANGE,
  CREEPS_PER_WAVE,
  CREEP_BASE_SPEED,
  CREEP_KIND,
  DEFAULT_TARGET_MODE,
  DIFFICULTY,
  ELEMENT,
  ENDLESS_BOSS_EVERY,
  FUSION_COST_SHARE,
  FUSION_DAMAGE_BONUS,
  findFusion,
  FIRST_WAVE_DELAY,
  FREEZE_CHANCE,
  FREEZE_LEVEL,
  FREEZE_SECONDS,
  LENGTH,
  POISON_DPS_PER_STACK,
  POISON_MAX_STACKS_BASE,
  POISON_SECONDS,
  POISON_STACKS_PER_LEVEL,
  RUSH_GOLD_PER_TICK,
  SEND,
  SEND_COST_ESCALATION,
  SLOW_FACTOR_BASE,
  SLOW_FACTOR_PER_LEVEL,
  SLOW_SECONDS,
  SPAWN_INTERVAL,
  TICK_RATE,
  TOWER_LEVEL_MAX,
  WAVE_INTERVAL,
  WAVE_PATTERN,
  towerCooldownTicks,
  healCost,
  towerCost,
  towerDamage,
  towerRange,
  waveBounty,
  waveHp,
} from "./balance";
import {
  airPath,
  cellCenter,
  cellCol,
  cellRow,
  getMap,
  pointAtProgress,
  type GameMap,
} from "./map";
import { Rng } from "./rng";
import type {
  AuraBonus,
  Command,
  Creep,
  CreepKind,
  Difficulty,
  ElementId,
  Field,
  GameMode,
  GameState,
  MatchLength,
  Projectile,
  SpawnEntry,
  Tower,
} from "./types";

export interface GameOptions {
  mode: GameMode;
  difficulty: Difficulty;
  length: MatchLength;
  mapId: string;
  seed: number;
}

const NO_AURA: AuraBonus = { damageMult: 1, rateMult: 1, rangeMult: 1 };

export function createGame(options: GameOptions): GameState {
  const fieldCount = options.mode === "versus" ? 2 : 1;
  const cfg = DIFFICULTY[options.difficulty];
  const fields: Field[] = [];
  for (let i = 0; i < fieldCount; i++) {
    fields.push({
      owner: i,
      gold: cfg.startGold,
      lives: cfg.startLives,
      towers: [],
      creeps: [],
      projectiles: [],
      waveIndex: 0,
      waveTimer: FIRST_WAVE_DELAY,
      spawnQueue: [],
      income: 0,
      occupied: new Map(),
      auraCache: new Map(),
      alive: true,
      rushedThisWave: false,
      events: [],
      stats: {
        goldEarned: 0,
        goldSpent: 0,
        creepsKilled: 0,
        creepsLeaked: 0,
        wavesSurvived: 0,
        sentCount: 0,
        sentByKind: {},
        healCount: 0,
      },
    });
  }

  return {
    tick: 0,
    rngState: options.seed >>> 0,
    mode: options.mode,
    difficulty: options.difficulty,
    length: options.length,
    mapId: options.mapId,
    fields,
    nextEntityId: 1,
    over: false,
    winner: null,
    endReason: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Команды
// ─────────────────────────────────────────────────────────────────────────────

/** Применяет команду. Возвращает false, если ход невозможен (нет золота и т.п.). */
export function applyCommand(state: GameState, cmd: Command): boolean {
  const field = state.fields[cmd.field];
  if (!field || !field.alive || state.over) return false;
  const map = getMap(state.mapId);

  switch (cmd.t) {
    case "build": {
      if (field.occupied.has(cmd.cell)) return false;
      if (!map.buildSet.has(cmd.cell)) return false;
      const cost = towerCost(cmd.element, 1);
      if (field.gold < cost) return false;

      const center = cellCenter(cmd.cell);
      const tower: Tower = {
        id: state.nextEntityId++,
        cell: cmd.cell,
        x: center.x,
        y: center.y,
        element: cmd.element,
        level: 1,
        fused: null,
        cooldown: 0,
        targetMode: DEFAULT_TARGET_MODE,
        invested: cost,
        damageDealt: 0,
      };
      field.gold -= cost;
      field.stats.goldSpent += cost;
      field.towers.push(tower);
      field.occupied.set(cmd.cell, tower.id);
      recalcAuras(field);
      return true;
    }

    case "upgrade": {
      const tower = field.towers.find((t) => t.id === cmd.tower);
      if (!tower || tower.level >= TOWER_LEVEL_MAX) return false;
      const cost = towerCost(tower.element, tower.level + 1);
      if (field.gold < cost) return false;

      field.gold -= cost;
      field.stats.goldSpent += cost;
      tower.level++;
      tower.invested += cost;
      recalcAuras(field);
      return true;
    }

    case "sell": {
      const index = field.towers.findIndex((t) => t.id === cmd.tower);
      if (index < 0) return false;
      const tower = field.towers[index]!;
      releaseProjectiles(field, tower.id);
      const refund = Math.floor(
        tower.invested * DIFFICULTY[state.difficulty].sellRefund,
      );
      field.gold += refund;
      field.occupied.delete(tower.cell);
      field.towers.splice(index, 1);
      recalcAuras(field);
      return true;
    }

    case "target": {
      const tower = field.towers.find((t) => t.id === cmd.tower);
      if (!tower) return false;
      tower.targetMode = cmd.mode;
      return true;
    }

    case "send": {
      if (state.mode !== "versus") return false;
      const target = state.fields[1 - cmd.field];
      if (!target || !target.alive) return false;
      const send = SEND[cmd.kind];
      if (!send) return false;

      // Каждая следующая отправка того же типа дорожает — иначе весь версус
      // сводится к спаму одним самым выгодным монстром. Считать надо именно
      // по типу: от общего счётчика дорожали и те монстры, которых игрок
      // ещё ни разу не посылал.
      const alreadySent = field.stats.sentByKind[cmd.kind] ?? 0;
      const cost = Math.round(
        send.cost * Math.pow(SEND_COST_ESCALATION, alreadySent),
      );
      if (field.gold < cost) return false;

      field.gold -= cost;
      field.stats.goldSpent += cost;
      field.stats.sentCount++;
      field.stats.sentByKind[cmd.kind] = alreadySent + 1;
      field.income += send.income;

      const kindCfg = CREEP_KIND[cmd.kind];
      const hp = waveHp(target.waveIndex, state.difficulty) * kindCfg.hpMult;
      const bounty = Math.round(
        waveBounty(target.waveIndex, state.difficulty) * kindCfg.bountyMult,
      );
      target.spawnQueue.push({
        tick: state.tick + 2,
        kind: cmd.kind,
        hp,
        bounty,
        sent: true,
      });
      return true;
    }

    case "rush": {
      if (field.waveTimer <= 0) return false;
      // Один призыв на волну. Иначе команда обнуляет таймер, обработка волн
      // тут же ставит его заново, и следующий тик снова принимает призыв —
      // выплаты идут потоком, а волны сыплются лавиной.
      if (field.rushedThisWave) return false;

      // После последней волны звать некого, а золото раньше продолжало капать.
      const totalWaves = LENGTH[state.length].totalWaves;
      if (totalWaves !== null && field.waveIndex >= totalWaves) return false;

      const bonus = Math.round(field.waveTimer * RUSH_GOLD_PER_TICK);
      field.gold += bonus;
      field.stats.goldEarned += bonus;
      field.waveTimer = 0;
      field.rushedThisWave = true;
      return true;
    }

    case "fuse": {
      const main = field.towers.find((t) => t.id === cmd.tower);
      const other = field.towers.find((t) => t.id === cmd.with);
      if (!main || !other || main.id === other.id) return false;
      // Уже слитую башню второй раз не сольёшь — иначе получится ёлка
      // из всех шести стихий в одной клетке.
      if (main.fused || other.fused) return false;
      if (!areNeighbours(main.cell, other.cell)) return false;
      if (!findFusion(main.element, other.element)) return false;

      // Считаем от вложенного в обе башни. Раньше цена бралась только с
      // жертвы: слить дешёвую башню первого уровня с максимальной стоило
      // копейки и давало ей четверть урона сверху даром.
      const cost = Math.round(
        (main.invested + other.invested) * FUSION_COST_SHARE,
      );
      if (field.gold < cost) return false;

      field.gold -= cost;
      field.stats.goldSpent += cost;
      main.fused = other.element;
      main.level = Math.max(main.level, other.level);
      main.invested += other.invested + cost;

      releaseProjectiles(field, other.id);
      field.occupied.delete(other.cell);
      field.towers.splice(field.towers.indexOf(other), 1);
      recalcAuras(field);
      return true;
    }

    case "heal": {
      const cost = healCost(field.stats.healCount);
      if (field.gold < cost) return false;
      field.gold -= cost;
      field.stats.goldSpent += cost;
      field.stats.healCount++;
      field.lives++;
      return true;
    }
  }
}

/**
 * Снимает бронь урона со снарядов исчезнувшей башни.
 *
 * Летящие снаряды учитываются в поле incoming, чтобы другие башни не
 * стреляли по уже обречённой цели. Если башня продана или слита, её снаряды
 * до цели не долетят, и бронь надо снять — иначе монстр до конца жизни
 * считается обречённым, и по нему никто больше не стреляет.
 */
function releaseProjectiles(field: Field, towerId: number): void {
  let write = 0;
  for (const projectile of field.projectiles) {
    if (projectile.towerId === towerId) {
      const target = field.creeps.find((c) => c.id === projectile.targetId);
      if (target) {
        target.incoming = Math.max(
          0,
          target.incoming -
            effectiveDamage(target, projectile.damage, projectile.damageType),
        );
      }
      continue;
    }
    field.projectiles[write++] = projectile;
  }
  field.projectiles.length = write;
}

/** Соседние ли клетки, включая диагонали. */
function areNeighbours(a: number, b: number): boolean {
  const dc = Math.abs(cellCol(a) - cellCol(b));
  const dr = Math.abs(cellRow(a) - cellRow(b));
  return dc <= 1 && dr <= 1 && (dc !== 0 || dr !== 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Тик
// ─────────────────────────────────────────────────────────────────────────────

export function step(
  state: GameState,
  commands: readonly Command[] = [],
): void {
  if (state.over) return;

  for (const cmd of commands) applyCommand(state, cmd);

  state.tick++;
  const rng = new Rng(state.rngState);
  const map = getMap(state.mapId);

  for (const field of state.fields) {
    if (!field.alive) continue;
    field.events.length = 0;
    updateWaves(state, field, rng);
    updateSpawns(state, field, map);
    updateCreeps(field, map);
    updateTowers(state, field, rng);
    updateProjectiles(field, rng);
  }

  state.rngState = rng.state;
  checkGameOver(state);
}

function updateWaves(state: GameState, field: Field, rng: Rng): void {
  if (field.waveTimer > 0) {
    field.waveTimer--;
    return;
  }

  const lengthCfg = LENGTH[state.length];
  if (
    lengthCfg.totalWaves !== null &&
    field.waveIndex >= lengthCfg.totalWaves
  ) {
    // Волны кончились — ждём, пока добьют оставшихся.
    field.waveTimer = TICK_RATE;
    return;
  }

  spawnWave(state, field, rng);
  field.rushedThisWave = false;
  field.events.push({
    t: "wave",
    index: field.waveIndex + 1,
    boss: field.spawnQueue.some((e) => e.kind === "boss"),
  });
  field.waveIndex++;
  field.waveTimer = WAVE_INTERVAL;

  // Доход и проценты начисляются за пережитую волну, а не за убийство:
  // так выгодно не терять жизни, а не просто фармить.
  const cfg = DIFFICULTY[state.difficulty];
  const interest = Math.min(
    Math.floor(field.gold * cfg.interestRate),
    cfg.interestCap,
  );
  const gain = interest + Math.floor(field.income);
  field.gold += gain;
  field.stats.goldEarned += gain;
  field.stats.wavesSurvived = field.waveIndex;
}

function spawnWave(state: GameState, field: Field, _rng: Rng): void {
  const waveNumber = field.waveIndex + 1;
  const lengthCfg = LENGTH[state.length];
  const isBoss =
    lengthCfg.totalWaves === null
      ? waveNumber % ENDLESS_BOSS_EVERY === 0
      : lengthCfg.bossWaves.includes(waveNumber);

  const kind: CreepKind = isBoss
    ? "boss"
    : (WAVE_PATTERN[field.waveIndex % WAVE_PATTERN.length] ?? "normal");

  const kindCfg = CREEP_KIND[kind];
  const count = Math.max(1, Math.round(CREEPS_PER_WAVE * kindCfg.countMult));
  const hp = waveHp(field.waveIndex, state.difficulty) * kindCfg.hpMult;
  const bounty = Math.max(
    1,
    Math.round(
      waveBounty(field.waveIndex, state.difficulty) * kindCfg.bountyMult,
    ),
  );

  for (let i = 0; i < count; i++) {
    field.spawnQueue.push({
      tick: state.tick + i * SPAWN_INTERVAL,
      kind,
      hp,
      bounty,
      sent: false,
    });
  }
}

function updateSpawns(state: GameState, field: Field, map: GameMap): void {
  if (field.spawnQueue.length === 0) return;
  const remaining: SpawnEntry[] = [];
  for (const entry of field.spawnQueue) {
    if (entry.tick > state.tick) {
      remaining.push(entry);
      continue;
    }
    field.creeps.push(makeCreep(state, entry, map));
  }
  field.spawnQueue = remaining;
}

function makeCreep(state: GameState, entry: SpawnEntry, map: GameMap): Creep {
  const cfg = CREEP_KIND[entry.kind];
  const start = cfg.flying ? airPath(map).from : map.path[0]!;
  return {
    id: state.nextEntityId++,
    kind: entry.kind,
    hp: entry.hp,
    maxHp: entry.hp,
    baseSpeed: CREEP_BASE_SPEED * cfg.speedMult,
    armor: cfg.armor,
    resist: cfg.resist,
    flying: cfg.flying,
    progress: 0,
    x: start.x,
    y: start.y,
    bounty: entry.bounty,
    leak: cfg.leak,
    slowFactor: 1,
    slowTicks: 0,
    freezeTicks: 0,
    burnTicks: 0,
    burnDamage: 0,
    poisonStacks: 0,
    poisonTicks: 0,
    armorShred: 0,
    incoming: 0,
  };
}

function updateCreeps(field: Field, map: GameMap): void {
  const air = airPath(map);
  const creeps = field.creeps;
  let write = 0;

  for (let i = 0; i < creeps.length; i++) {
    const c = creeps[i]!;

    // Периодический урон. Начисляется до движения, чтобы монстр,
    // добитый ядом на последнем шаге, не успел утечь.
    if (c.burnTicks > 0) {
      c.hp -= c.burnDamage;
      c.burnTicks--;
    }
    if (c.poisonTicks > 0 && c.poisonStacks > 0) {
      c.hp -= (POISON_DPS_PER_STACK * c.poisonStacks) / TICK_RATE;
      c.poisonTicks--;
      if (c.poisonTicks === 0) c.poisonStacks = 0;
    }

    if (c.hp <= 0) {
      field.gold += c.bounty;
      field.stats.goldEarned += c.bounty;
      field.stats.creepsKilled++;
      field.events.push({ t: "kill", x: c.x, y: c.y, bounty: c.bounty });
      continue;
    }

    // Замедление и заморозка.
    if (c.freezeTicks > 0) {
      c.freezeTicks--;
    } else {
      if (c.slowTicks > 0) {
        c.slowTicks--;
        if (c.slowTicks === 0) c.slowFactor = 1;
      }
      c.progress += c.baseSpeed * c.slowFactor;
    }

    const total = c.flying ? air.length : map.pathLength;
    if (c.progress >= total) {
      field.lives -= c.leak;
      field.stats.creepsLeaked++;
      field.events.push({ t: "leak", lives: c.leak });
      if (field.lives <= 0) {
        field.lives = 0;
        field.alive = false;
      }
      continue;
    }

    if (c.flying) {
      const t = c.progress / air.length;
      c.x = air.from.x + (air.to.x - air.from.x) * t;
      c.y = air.from.y + (air.to.y - air.from.y) * t;
    } else {
      const point = pointAtProgress(map, c.progress);
      c.x = point.x;
      c.y = point.y;
    }

    creeps[write++] = c;
  }

  creeps.length = write;
}

function updateTowers(state: GameState, field: Field, rng: Rng): void {
  if (field.creeps.length === 0) {
    for (const tower of field.towers) {
      if (tower.cooldown > 0) tower.cooldown--;
    }
    return;
  }

  for (const tower of field.towers) {
    if (tower.element === "light") continue;
    if (tower.cooldown > 0) {
      tower.cooldown--;
      continue;
    }

    const aura = field.auraCache.get(tower.id) ?? NO_AURA;
    const range = towerRange(tower.element, tower.level) * aura.rangeMult;
    const target = pickTarget(field, tower, range);
    if (!target) continue;

    const damage =
      towerDamage(tower.element, tower.level) *
      aura.damageMult *
      (tower.fused ? FUSION_DAMAGE_BONUS : 1);
    fire(state, field, tower, target, damage, rng);

    const cooldown =
      towerCooldownTicks(tower.element, tower.level) / aura.rateMult;
    tower.cooldown = Math.max(1, Math.round(cooldown));
  }
}

function pickTarget(field: Field, tower: Tower, range: number): Creep | null {
  const canHitAir = ELEMENT[tower.element].canHitAir;
  const rangeSq = range * range;
  let best: Creep | null = null;
  let bestScore = -Infinity;

  // Первый проход — только те, кого летящие снаряды ещё не добили.
  // Если таких не осталось, стреляем по кому попало: пусть лучше перебор,
  // чем простой башни.
  let fallback: Creep | null = null;
  let fallbackScore = -Infinity;

  for (const c of field.creeps) {
    if (c.flying && !canHitAir) continue;
    // Убитые на этом тике исчезнут только при следующей обработке движения,
    // но стрелять по ним уже незачем.
    if (c.hp <= 0) continue;
    const dx = c.x - tower.x;
    const dy = c.y - tower.y;
    const distSq = dx * dx + dy * dy;
    if (distSq > rangeSq) continue;

    let score: number;
    switch (tower.targetMode) {
      case "first":
        score = c.progress;
        break;
      case "strongest":
        score = c.hp;
        break;
      case "fastest":
        score = c.baseSpeed * c.slowFactor;
        break;
      case "closest":
        score = -distSq;
        break;
    }
    if (score > fallbackScore) {
      fallbackScore = score;
      fallback = c;
    }
    if (c.incoming >= c.hp) continue;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }

  return best ?? fallback;
}

function fire(
  state: GameState,
  field: Field,
  tower: Tower,
  target: Creep,
  damage: number,
  rng: Rng,
): void {
  const cfg = ELEMENT[tower.element];
  field.events.push({
    t: "shoot",
    element: tower.element,
    x: tower.x,
    y: tower.y,
  });

  // Молния бьёт мгновенно и прыгает по цепи — снаряд ей не нужен.
  if (tower.element === "lightning") {
    chainLightning(field, tower, target, damage);
    return;
  }

  if (cfg.projectileSpeed <= 0) {
    hitCreep(field, tower, target, damage, rng);
    return;
  }

  const projectile: Projectile = {
    id: state.nextEntityId++,
    x: tower.x,
    y: tower.y,
    targetId: target.id,
    speed: cfg.projectileSpeed,
    damage,
    damageType: cfg.damageType,
    element: tower.element,
    splash: cfg.splash > 0 ? cfg.splash * (1 + (tower.level - 1) * 0.12) : 0,
    level: tower.level,
    towerId: tower.id,
  };
  field.projectiles.push(projectile);
  target.incoming += effectiveDamage(target, damage, cfg.damageType);
}

/** Урон после брони или сопротивления — сколько на самом деле снимется. */
function effectiveDamage(
  target: Creep,
  amount: number,
  type: "physical" | "magical",
): number {
  const reduction =
    type === "physical"
      ? Math.max(0, target.armor - target.armorShred)
      : target.resist;
  return amount * (1 - reduction);
}

function chainLightning(
  field: Field,
  tower: Tower,
  first: Creep,
  damage: number,
): void {
  const links = 1 + tower.level;
  const hitIds = new Set<number>();
  const points: { x: number; y: number }[] = [{ x: tower.x, y: tower.y }];
  let current = first;
  let currentDamage = damage;

  for (let i = 0; i < links; i++) {
    applyDamage(field, tower, current, currentDamage, "magical");
    hitIds.add(current.id);
    points.push({ x: current.x, y: current.y });

    currentDamage *= CHAIN_FALLOFF;
    const next = nearestUnhit(field, current, hitIds, CHAIN_RANGE);
    if (!next) break;
    current = next;
  }

  field.events.push({ t: "chain", points });
}

function nearestUnhit(
  field: Field,
  from: Creep,
  exclude: Set<number>,
  range: number,
): Creep | null {
  const rangeSq = range * range;
  let best: Creep | null = null;
  let bestDist = Infinity;
  for (const c of field.creeps) {
    if (exclude.has(c.id) || c.hp <= 0) continue;
    const dx = c.x - from.x;
    const dy = c.y - from.y;
    const distSq = dx * dx + dy * dy;
    if (distSq > rangeSq || distSq >= bestDist) continue;
    bestDist = distSq;
    best = c;
  }
  return best;
}

function updateProjectiles(field: Field, rng: Rng): void {
  if (field.projectiles.length === 0) return;
  const list = field.projectiles;
  let write = 0;

  for (let i = 0; i < list.length; i++) {
    const p = list[i]!;
    const target = field.creeps.find((c) => c.id === p.targetId);

    // Цель умерла до попадания — снаряд пропадает. Так проще и честнее,
    // чем перенаводить: иначе башни никогда не тратят выстрелы впустую.
    if (!target) continue;

    const dx = target.x - p.x;
    const dy = target.y - p.y;
    const dist = Math.hypot(dx, dy);

    if (dist <= p.speed) {
      target.incoming = Math.max(
        0,
        target.incoming - effectiveDamage(target, p.damage, p.damageType),
      );
      const tower = field.towers.find((t) => t.id === p.towerId);
      if (tower) hitProjectile(field, tower, p, target, rng);
      continue;
    }

    p.x += (dx / dist) * p.speed;
    p.y += (dy / dist) * p.speed;
    list[write++] = p;
  }

  list.length = write;
}

function hitProjectile(
  field: Field,
  tower: Tower,
  projectile: Projectile,
  target: Creep,
  rng: Rng,
): void {
  hitCreep(field, tower, target, projectile.damage, rng);

  if (projectile.splash > 0) {
    field.events.push({
      t: "explode",
      x: target.x,
      y: target.y,
      radius: projectile.splash,
    });
    const splashSq = projectile.splash * projectile.splash;
    for (const c of field.creeps) {
      if (c.id === target.id || c.hp <= 0) continue;
      if (c.flying) continue;
      const dx = c.x - target.x;
      const dy = c.y - target.y;
      if (dx * dx + dy * dy > splashSq) continue;
      // Взрывом по соседям прилетает половина — иначе земля вытесняет всё.
      applyDamage(field, tower, c, projectile.damage * 0.5, "physical");
    }
  }
}

/** Попадание одиночным выстрелом: урон плюс эффект стихии. */
function hitCreep(
  field: Field,
  tower: Tower,
  target: Creep,
  damage: number,
  rng: Rng,
): void {
  const cfg = ELEMENT[tower.element];
  applyDamage(field, tower, target, damage, cfg.damageType);

  applyElementEffect(tower, tower.element, target, damage, rng);
  // Комбо-башня накладывает эффект и второй стихии — ради этого её и собирают.
  if (tower.fused) applyElementEffect(tower, tower.fused, target, damage, rng);
}

function applyElementEffect(
  tower: Tower,
  element: ElementId,
  target: Creep,
  damage: number,
  rng: Rng,
): void {
  switch (element) {
    case "fire": {
      const share =
        tower.level >= BURN_UPGRADE_LEVEL
          ? BURN_UPGRADE_SHARE
          : BURN_DAMAGE_SHARE;
      const ticks = BURN_SECONDS * TICK_RATE;
      target.burnTicks = ticks;
      target.burnDamage = (damage * share) / ticks;
      break;
    }
    case "ice": {
      const factor = Math.max(
        0.25,
        SLOW_FACTOR_BASE - (tower.level - 1) * SLOW_FACTOR_PER_LEVEL,
      );
      // Замедления не складываются — берётся самое сильное.
      if (factor < target.slowFactor || target.slowTicks === 0)
        target.slowFactor = factor;
      target.slowTicks = SLOW_SECONDS * TICK_RATE;

      if (
        tower.level >= FREEZE_LEVEL &&
        !CREEP_KIND[target.kind].freezeImmune &&
        rng.chance(FREEZE_CHANCE)
      ) {
        target.freezeTicks = Math.round(FREEZE_SECONDS * TICK_RATE);
      }
      break;
    }
    case "poison": {
      const maxStacks =
        POISON_MAX_STACKS_BASE + (tower.level - 1) * POISON_STACKS_PER_LEVEL;
      target.poisonStacks = Math.min(maxStacks, target.poisonStacks + 1);
      target.poisonTicks = POISON_SECONDS * TICK_RATE;
      break;
    }
    default:
      break;
  }
}

function applyDamage(
  field: Field,
  tower: Tower,
  target: Creep,
  amount: number,
  type: "physical" | "magical",
): void {
  const reduction =
    type === "physical"
      ? Math.max(0, target.armor - target.armorShred)
      : target.resist;
  const dealt = amount * (1 - reduction);
  target.hp -= dealt;
  tower.damageDealt += dealt;
}

/**
 * Пересчёт бонусов от аур света. Вызывается только при изменении застройки —
 * каждый тик это считать незачем, состав башен между постройками не меняется.
 */
export function recalcAuras(field: Field): void {
  field.auraCache.clear();
  const auras = field.towers.filter((t) => t.element === "light");
  if (auras.length === 0) return;

  for (const tower of field.towers) {
    if (tower.element === "light") continue;
    let damageMult = 1;
    let rateMult = 1;
    let rangeMult = 1;

    for (const aura of auras) {
      const radius =
        AURA_RADIUS_BASE + (aura.level - 1) * AURA_RADIUS_PER_LEVEL;
      const dx = tower.x - aura.x;
      const dy = tower.y - aura.y;
      if (dx * dx + dy * dy > radius * radius) continue;
      damageMult += AURA_DAMAGE_PER_LEVEL * aura.level;
      rateMult += AURA_RATE_PER_LEVEL * aura.level;
      rangeMult += AURA_RANGE_PER_LEVEL * aura.level;
    }

    if (damageMult !== 1 || rateMult !== 1 || rangeMult !== 1) {
      field.auraCache.set(tower.id, { damageMult, rateMult, rangeMult });
    }
  }
}

function checkGameOver(state: GameState): void {
  const lengthCfg = LENGTH[state.length];

  if (state.mode === "versus") {
    const [a, b] = state.fields;
    if (!a || !b) return;
    if (!a.alive && !b.alive) {
      state.over = true;
      state.winner = null;
      state.endReason = "draw";
      return;
    }
    if (!a.alive || !b.alive) {
      state.over = true;
      state.winner = a.alive ? 0 : 1;
      state.endReason = "lives";
      return;
    }
    if (
      lengthCfg.totalWaves !== null &&
      bothCleared(state, lengthCfg.totalWaves)
    ) {
      state.over = true;
      state.endReason = "waves-cleared";
      state.winner = a.lives === b.lives ? null : a.lives > b.lives ? 0 : 1;
    }
    return;
  }

  const field = state.fields[0];
  if (!field) return;
  if (!field.alive) {
    state.over = true;
    state.winner = null;
    state.endReason = "lives";
    return;
  }
  if (
    lengthCfg.totalWaves !== null &&
    field.waveIndex >= lengthCfg.totalWaves &&
    field.creeps.length === 0 &&
    field.spawnQueue.length === 0
  ) {
    state.over = true;
    state.winner = 0;
    state.endReason = "waves-cleared";
  }
}

function bothCleared(state: GameState, totalWaves: number): boolean {
  return state.fields.every(
    (f) =>
      f.waveIndex >= totalWaves &&
      f.creeps.length === 0 &&
      f.spawnQueue.length === 0,
  );
}

/** Сколько стоит следующая отправка монстра — нужно интерфейсу и боту. */
export function sendCost(field: Field, kind: CreepKind): number | null {
  const send = SEND[kind];
  if (!send) return null;
  return Math.round(
    send.cost * Math.pow(SEND_COST_ESCALATION, field.stats.sentByKind[kind] ?? 0),
  );
}
