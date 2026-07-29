/**
 * Упаковка состояния для отправки и распаковка на стороне гостя.
 *
 * Гость не симулирует партию, поэтому получает не полное состояние, а ровно
 * то, что нужно нарисовать и показать в интерфейсе. Всё остальное — очередь
 * спавна, генератор случайных чисел, накопленный урон башен — остаётся у хоста.
 */

import { CREEP_KIND, CREEP_BASE_SPEED } from "../core/balance";
import { cellCenter } from "../core/map";
import type { Creep, Field, GameState, Projectile, Tower } from "../core/types";
import {
  CREEP_KINDS,
  ELEMENTS,
  FLAG_BURN,
  FLAG_FREEZE,
  FLAG_POISON,
  FLAG_SLOW,
  TARGET_MODES,
  type FieldSnapshot,
  type Snapshot,
} from "./protocol";

/** Округление до целого пикселя: дробная часть в снимке не нужна никому. */
const round = (value: number): number => Math.round(value);

export function encodeSnapshot(state: GameState): Snapshot {
  return {
    tick: state.tick,
    over: state.over,
    winner: state.winner,
    fields: state.fields.map(encodeField),
  };
}

function encodeField(field: Field): FieldSnapshot {
  return {
    gold: round(field.gold),
    lives: field.lives,
    wave: field.waveIndex,
    waveTimer: field.waveTimer,
    alive: field.alive,
    sentCount: field.stats.sentCount,
    healCount: field.stats.healCount,
    sentByKind: (Object.entries(field.stats.sentByKind) as [string, number][])
      .filter(([, n]) => n > 0)
      .map(([kind, n]) => [CREEP_KINDS.indexOf(kind as never), n]),
    killed: field.stats.creepsKilled,
    leaked: field.stats.creepsLeaked,
    earned: Math.round(field.stats.goldEarned),
    creeps: field.creeps.map((c) => [
      c.id,
      CREEP_KINDS.indexOf(c.kind),
      round(c.x),
      round(c.y),
      round(c.hp),
      round(c.maxHp),
      (c.slowTicks > 0 ? FLAG_SLOW : 0) |
        (c.freezeTicks > 0 ? FLAG_FREEZE : 0) |
        (c.burnTicks > 0 ? FLAG_BURN : 0) |
        (c.poisonStacks > 0 ? FLAG_POISON : 0),
    ]),
    towers: field.towers.map((t) => [
      t.id,
      t.cell,
      ELEMENTS.indexOf(t.element),
      t.level,
      TARGET_MODES.indexOf(t.targetMode),
      t.fused ? ELEMENTS.indexOf(t.fused) : -1,
      // Без этого у гостя цена продажи и цена слияния показывались нулями.
      Math.round(t.invested),
    ]),
    projectiles: field.projectiles.map((p) => [
      round(p.x),
      round(p.y),
      ELEMENTS.indexOf(p.element),
      round(p.splash),
    ]),
  };
}

/**
 * Разворачивает снимок обратно в структуры, которые понимает рисовалка.
 * Поля, которых в снимке нет, заполняются правдоподобно — рендер их не читает,
 * но типы должны сойтись, и в них не должно быть мусора вроде NaN.
 */
export function decodeField(snapshot: FieldSnapshot, owner: number): Field {
  const creeps: Creep[] = snapshot.creeps.map((c) => {
    const kind = CREEP_KINDS[c[1]] ?? "normal";
    const cfg = CREEP_KIND[kind];
    return {
      id: c[0],
      kind,
      x: c[2],
      y: c[3],
      hp: c[4],
      maxHp: c[5],
      baseSpeed: CREEP_BASE_SPEED * cfg.speedMult,
      armor: cfg.armor,
      resist: cfg.resist,
      flying: cfg.flying,
      progress: 0,
      bounty: 0,
      leak: cfg.leak,
      slowFactor: (c[6] & FLAG_SLOW) !== 0 ? 0.6 : 1,
      slowTicks: (c[6] & FLAG_SLOW) !== 0 ? 1 : 0,
      freezeTicks: (c[6] & FLAG_FREEZE) !== 0 ? 1 : 0,
      burnTicks: (c[6] & FLAG_BURN) !== 0 ? 1 : 0,
      burnDamage: 0,
      poisonStacks: (c[6] & FLAG_POISON) !== 0 ? 1 : 0,
      poisonTicks: (c[6] & FLAG_POISON) !== 0 ? 1 : 0,
      armorShred: 0,
      incoming: 0,
    };
  });

  const towers: Tower[] = snapshot.towers.map((t) => {
    const center = cellCenter(t[1]);
    return {
      id: t[0],
      cell: t[1],
      x: center.x,
      y: center.y,
      element: ELEMENTS[t[2]] ?? "fire",
      level: t[3],
      fused: t[5] >= 0 ? (ELEMENTS[t[5]] ?? null) : null,
      cooldown: 0,
      targetMode: TARGET_MODES[t[4]] ?? "closest",
      invested: t[6] ?? 0,
      damageDealt: 0,
    };
  });

  const projectiles: Projectile[] = snapshot.projectiles.map((p, index) => ({
    id: index,
    x: p[0],
    y: p[1],
    targetId: 0,
    speed: 0,
    damage: 0,
    damageType: "magical",
    element: ELEMENTS[p[2]] ?? "fire",
    splash: p[3],
    level: 1,
    towerId: 0,
  }));

  const occupied = new Map<number, number>();
  for (const tower of towers) occupied.set(tower.cell, tower.id);

  const sentByKind: Partial<Record<string, number>> = {};
  for (const [kindIndex, count] of snapshot.sentByKind ?? []) {
    const kind = CREEP_KINDS[kindIndex];
    if (kind) sentByKind[kind] = count;
  }

  return {
    owner,
    gold: snapshot.gold,
    lives: snapshot.lives,
    towers,
    creeps,
    projectiles,
    waveIndex: snapshot.wave,
    waveTimer: snapshot.waveTimer,
    spawnQueue: [],
    income: 0,
    occupied,
    auraCache: new Map(),
    alive: snapshot.alive,
    lastRushTick: -Infinity,
    events: [],
    stats: {
      goldEarned: snapshot.earned ?? 0,
      goldSpent: 0,
      creepsKilled: snapshot.killed ?? 0,
      creepsLeaked: snapshot.leaked ?? 0,
      wavesSurvived: snapshot.wave,
      sentCount: snapshot.sentCount,
      sentByKind,
      healCount: snapshot.healCount,
    },
  };
}
