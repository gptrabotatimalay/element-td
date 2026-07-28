/**
 * Стратегии автоигрока.
 *
 * Две роли сразу:
 *  1. Противник-бот в режиме «версус с ИИ».
 *  2. Инструмент проверки баланса — прогон тысяч партий разными стратегиями.
 *
 * Второе важнее первого. Если эталонно плохая стратегия («качай одну башню»)
 * проходит хардкор — экономика сломана, и это должно всплыть автоматически,
 * а не на глазах у игроков.
 *
 * Все стратегии детерминированы: свой генератор от сида, никакого Math.random.
 */

import {
  FUSION_COST_SHARE,
  TOWER_LEVEL_MAX,
  findFusion,
  healCost,
  towerCost,
} from "../core/balance";
import { cellCol, cellRow, getMap } from "../core/map";
import { Rng } from "../core/rng";
import { sendCost } from "../core/sim";
import type {
  Command,
  CreepKind,
  ElementId,
  Field,
  GameState,
} from "../core/types";
import { coverageMap, rankedCells } from "./coverage";

export interface Strategy {
  id: string;
  label: string;
  /** Как часто бот думает, в тиках. Реже — слабее играет. */
  thinkInterval: number;
  decide(ctx: DecisionContext): Command[];
}

export interface DecisionContext {
  state: GameState;
  field: Field;
  fieldIndex: number;
  /** Клетки под застройку, от лучшей к худшей, без занятых. */
  freeCells: number[];
  rng: Rng;
}

const ATTACK_ELEMENTS: ElementId[] = [
  "fire",
  "ice",
  "lightning",
  "earth",
  "poison",
];

function firstFreeCell(ctx: DecisionContext): number | null {
  return ctx.freeCells[0] ?? null;
}

/** Построить башню, если хватает золота. */
function build(ctx: DecisionContext, element: ElementId): Command[] {
  const cell = firstFreeCell(ctx);
  if (cell === null) return [];
  if (ctx.field.gold < towerCost(element, 1)) return [];
  return [{ t: "build", field: ctx.fieldIndex, cell, element }];
}

/**
 * Прокачать самую полезную из доступных башен.
 *
 * «Самая дешёвая» — плохой выбор: золото размазывается по башням на отшибе,
 * которые стреляют пару раз за волну. Ориентир — покрытие маршрута: башня,
 * мимо которой монстры идут дольше всех, окупает каждый вложенный уровень.
 */
function upgradeBest(ctx: DecisionContext): Command[] {
  const coverage = coverageMap(getMap(ctx.state.mapId));
  let best: { id: number; score: number } | null = null;

  for (const tower of ctx.field.towers) {
    if (tower.level >= TOWER_LEVEL_MAX) continue;
    const cost = towerCost(tower.element, tower.level + 1);
    if (cost > ctx.field.gold) continue;

    // Ауры оцениваем по числу соседей, которых они усиливают,
    // а не по покрытию дороги — сами они не стреляют.
    const score =
      tower.element === "light"
        ? 0.5
        : (coverage.get(tower.cell) ?? 0) / Math.pow(1.5, tower.level - 1);

    if (!best || score > best.score) best = { id: tower.id, score };
  }

  if (!best) return buyLife(ctx);
  return [{ t: "upgrade", field: ctx.fieldIndex, tower: best.id }];
}

/**
 * Докупить жизнь. Последний осмысленный способ потратить золото, когда все
 * площадки застроены и всё выкачано — иначе к концу партии деньги просто
 * копятся, и экономика перестаёт что-либо ограничивать.
 */
function buyLife(ctx: DecisionContext): Command[] {
  const cost = healCost(ctx.field.stats.healCount);
  if (ctx.field.gold < cost) return [];
  return [{ t: "heal", field: ctx.fieldIndex }];
}

/**
 * Слить пару соседних башен, если есть подходящий рецепт.
 *
 * Бот делает это не только чтобы играть сильнее: без него механика комбо
 * вообще не попадала бы в прогоны баланса, и её перекос всплыл бы уже
 * у живых игроков.
 */
function fuseIfPossible(ctx: DecisionContext): Command[] {
  const field = ctx.field;
  for (const tower of field.towers) {
    if (tower.fused || tower.element === "light") continue;
    const col = cellCol(tower.cell);
    const row = cellRow(tower.cell);

    for (const other of field.towers) {
      if (other.id === tower.id || other.fused || other.element === "light") continue;
      if (Math.abs(cellCol(other.cell) - col) > 1) continue;
      if (Math.abs(cellRow(other.cell) - row) > 1) continue;
      if (!findFusion(tower.element, other.element)) continue;

      const cost = Math.round(other.invested * FUSION_COST_SHARE);
      if (field.gold < cost) continue;
      return [
        { t: "fuse", field: ctx.fieldIndex, tower: tower.id, with: other.id },
      ];
    }
  }
  return [];
}

/** Прокачать самую вложенную башню — стратегия «всё в одну». */
function upgradeStrongest(ctx: DecisionContext): Command[] {
  let best: { id: number; invested: number } | null = null;
  for (const tower of ctx.field.towers) {
    if (tower.level >= TOWER_LEVEL_MAX) continue;
    const cost = towerCost(tower.element, tower.level + 1);
    if (cost > ctx.field.gold) continue;
    if (!best || tower.invested > best.invested)
      best = { id: tower.id, invested: tower.invested };
  }
  if (!best) return [];
  return [{ t: "upgrade", field: ctx.fieldIndex, tower: best.id }];
}

/**
 * Эталонно плохая стратегия: одна башня, вкачанная до упора.
 * Если она проходит хардкор — цена уровней слишком щедрая.
 */
const greedySingle: Strategy = {
  id: "greedy-single",
  label: "Всё в одну башню",
  thinkInterval: 20,
  decide(ctx) {
    if (ctx.field.towers.length === 0) return build(ctx, "earth");
    const upgrade = upgradeStrongest(ctx);
    if (upgrade.length > 0) return upgrade;
    // Максимум достигнут — ставим вторую и качаем её же.
    if (ctx.field.towers.every((t) => t.level >= TOWER_LEVEL_MAX))
      return build(ctx, "earth");
    return [];
  },
};

/**
 * Противоположная крайность: только первый уровень, зато везде.
 * Если она проходит хардкор — уровни вообще не нужны, и это тоже поломка.
 */
const spreadCheap: Strategy = {
  id: "spread-cheap",
  label: "Много дешёвых башен",
  thinkInterval: 15,
  decide(ctx) {
    const element =
      ATTACK_ELEMENTS[ctx.field.towers.length % ATTACK_ELEMENTS.length]!;
    return build(ctx, element);
  },
};

/** Моно-стихия: проверяет, что ни одна стихия не вывозит партию в одиночку. */
function monoStrategy(element: ElementId): Strategy {
  return {
    id: `mono-${element}`,
    label: `Только ${element}`,
    thinkInterval: 15,
    decide(ctx) {
      const built = build(ctx, element);
      if (built.length > 0) return built;
      return upgradeBest(ctx);
    },
  };
}

/**
 * Разумная игра — верхняя планка. Должна проходить хардкор, но без запаса.
 *
 * Смысл в пропорциях, а не в переборе стихий по кругу. Костяк — чистый урон,
 * к нему добавляется немного контроля и аур, и только когда площадки кончились,
 * начинается прокачка. Если эта стратегия покажет тот же результат, что
 * «случайные ходы», значит решения игрока ни на что не влияют — и это худшее,
 * что может случиться с балансом.
 */
const DESIRED_MIX: { element: ElementId; share: number }[] = [
  { element: "fire", share: 0.3 },
  { element: "lightning", share: 0.22 },
  { element: "poison", share: 0.16 },
  { element: "ice", share: 0.14 },
  { element: "earth", share: 0.1 },
  { element: "light", share: 0.08 },
];

/** Какой стихии сейчас не хватает сильнее всего относительно нужных долей. */
function mostNeeded(ctx: DecisionContext): ElementId {
  const towers = ctx.field.towers;
  const total = Math.max(1, towers.length);
  let bestElement: ElementId = "fire";
  let bestDeficit = -Infinity;

  for (const { element, share } of DESIRED_MIX) {
    const have = towers.filter((t) => t.element === element).length / total;
    const deficit = share - have;
    if (deficit > bestDeficit) {
      bestDeficit = deficit;
      bestElement = element;
    }
  }
  return bestElement;
}

const balanced: Strategy = {
  id: "balanced",
  label: "Разумная игра",
  thinkInterval: 12,
  decide(ctx) {
    // Первые башни — только урон. Аура над пустым полем бесполезна,
    // а замедление без того, кто добьёт, просто оттягивает проигрыш.
    if (ctx.field.towers.length < 4) {
      const opener: ElementId =
        ctx.field.towers.length % 2 === 0 ? "fire" : "lightning";
      const built = build(ctx, opener);
      if (built.length > 0) return built;
      return upgradeBest(ctx);
    }

    if (ctx.freeCells.length > 0) {
      const built = build(ctx, mostNeeded(ctx));
      if (built.length > 0) return built;
    } else {
      // Место кончилось — слияние даёт силу, не занимая новых площадок.
      const fused = fuseIfPossible(ctx);
      if (fused.length > 0) return fused;
    }

    return upgradeBest(ctx);
  },
};

/**
 * Ставка на комбо: сливает при первой возможности.
 * Нужна как проверка, что комбо не превращается в единственно верную игру.
 */
const fusionist: Strategy = {
  id: "fusionist",
  label: "Ставка на комбо",
  thinkInterval: 12,
  decide(ctx) {
    const fused = fuseIfPossible(ctx);
    if (fused.length > 0) return fused;
    if (ctx.freeCells.length > 0) {
      const built = build(ctx, mostNeeded(ctx));
      if (built.length > 0) return built;
    }
    return upgradeBest(ctx);
  },
};

/**
 * Жмёт «волну раньше» при каждой возможности и строит по остаточному принципу.
 *
 * Проверяет, что досрочный призыв остаётся обменом времени на риск, а не
 * способом печатать золото: когда-то он срабатывал каждый тик и за сто секунд
 * приносил больше, чем вся партия честной игры.
 */
const rusher: Strategy = {
  id: "rusher",
  label: "Спам досрочных волн",
  thinkInterval: 1,
  decide(ctx) {
    if (ctx.field.waveTimer > 0) {
      return [{ t: "rush", field: ctx.fieldIndex }];
    }
    return balanced.decide(ctx);
  },
};

/** Случайная игра — нижняя граница. Хардкор она проходить не должна никогда. */
const chaotic: Strategy = {
  id: "chaotic",
  label: "Случайные ходы",
  thinkInterval: 18,
  decide(ctx) {
    if (ctx.rng.chance(0.6)) {
      const element = ctx.rng.pick(ATTACK_ELEMENTS) ?? "fire";
      const cell = ctx.rng.pick(ctx.freeCells);
      if (cell === undefined) return [];
      if (ctx.field.gold < towerCost(element, 1)) return [];
      return [{ t: "build", field: ctx.fieldIndex, cell, element }];
    }
    return upgradeBest(ctx);
  },
};

/**
 * Агрессивная стратегия для версуса: часть золота уходит в отправку монстров
 * противнику ради прироста дохода. Нужна, чтобы проверить, что агрессия
 * окупается, но не является безусловно выигрышной.
 */
const aggressive: Strategy = {
  id: "aggressive",
  label: "Давление отправками",
  thinkInterval: 12,
  decide(ctx) {
    const { state, field, fieldIndex } = ctx;

    if (state.mode === "versus" && field.lives > 5) {
      const kinds: CreepKind[] = ["normal", "fast", "swarm"];
      for (const kind of kinds) {
        const cost = sendCost(field, kind);
        // Отправляем только с запасом: половина золота должна остаться на оборону.
        if (cost !== null && field.gold > cost * 2) {
          return [{ t: "send", field: fieldIndex, kind }];
        }
      }
    }

    return balanced.decide(ctx);
  },
};

export const STRATEGIES: Strategy[] = [
  balanced,
  fusionist,
  rusher,
  aggressive,
  spreadCheap,
  greedySingle,
  chaotic,
  monoStrategy("fire"),
  monoStrategy("ice"),
  monoStrategy("lightning"),
  monoStrategy("earth"),
  monoStrategy("poison"),
];

export function getStrategy(id: string): Strategy {
  return STRATEGIES.find((s) => s.id === id) ?? balanced;
}

/**
 * Управление одним полем по стратегии. Держит собственный генератор,
 * чтобы решения бота не сдвигали генератор самой симуляции.
 */
export class AutoPlayer {
  private rng: Rng;
  private ranked: number[];

  constructor(
    public strategy: Strategy,
    public fieldIndex: number,
    seed: number,
    mapId: string,
  ) {
    this.rng = new Rng(seed >>> 0);
    this.ranked = rankedCells(getMap(mapId));
  }

  /** Команды на текущий тик. Пустой массив — бот пропускает ход. */
  update(state: GameState): Command[] {
    if (state.over) return [];
    if (state.tick % this.strategy.thinkInterval !== 0) return [];

    const field = state.fields[this.fieldIndex];
    if (!field || !field.alive) return [];

    const freeCells = this.ranked.filter((c) => !field.occupied.has(c));
    return this.strategy.decide({
      state,
      field,
      fieldIndex: this.fieldIndex,
      freeCells,
      rng: this.rng,
    });
  }
}
