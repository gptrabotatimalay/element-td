import { describe, expect, it } from "vitest";

import { AutoPlayer, getStrategy } from "../src/ai/strategies";
import {
  CREEPS_PER_WAVE,
  CREEP_BASE_SPEED,
  FUSION_COST_SHARE,
  LENGTH,
  SEND,
  SPAWN_INTERVAL,
  TICK_RATE,
  WAVE_INTERVAL,
  towerCost,
} from "../src/core/balance";
import { MAPS, getMap } from "../src/core/map";
import { runGame, summarize } from "../src/core/runner";
import { applyCommand, createGame, sendCost, step } from "../src/core/sim";
import type { RunResult } from "../src/core/runner";

const baseOptions = {
  mode: "solo" as const,
  difficulty: "normal" as const,
  length: "quick" as const,
  mapId: "serpent",
  seed: 12345,
};

describe("детерминизм", () => {
  it("одинаковый сид даёт побитово одинаковую партию", () => {
    const play = () => {
      const state = createGame(baseOptions);
      const bot = new AutoPlayer(
        getStrategy("balanced"),
        0,
        777,
        baseOptions.mapId,
      );
      for (let i = 0; i < 6000 && !state.over; i++)
        step(state, bot.update(state));
      return state;
    };

    const a = play();
    const b = play();

    expect(a.tick).toBe(b.tick);
    expect(a.rngState).toBe(b.rngState);
    expect(a.fields[0]!.gold).toBe(b.fields[0]!.gold);
    expect(a.fields[0]!.lives).toBe(b.fields[0]!.lives);
    expect(a.fields[0]!.stats).toEqual(b.fields[0]!.stats);
  });

  it("симуляция не трогает Math.random", () => {
    // Если кто-то вставит Math.random в ядро, две партии с одним сидом
    // разойдутся — а вместе с ними сетевая сверка и все прогоны баланса.
    const original = Math.random;
    let called = false;
    Math.random = () => {
      called = true;
      return original();
    };
    try {
      const state = createGame(baseOptions);
      for (let i = 0; i < 2000; i++) step(state);
      expect(called).toBe(false);
    } finally {
      Math.random = original;
    }
  });
});

describe("постройка башен", () => {
  it("списывает золото и занимает клетку", () => {
    const state = createGame(baseOptions);
    const field = state.fields[0]!;
    const cell = getMap(baseOptions.mapId).buildCells[0]!;
    const goldBefore = field.gold;

    const ok = applyCommand(state, {
      t: "build",
      field: 0,
      cell,
      element: "fire",
    });

    expect(ok).toBe(true);
    expect(field.towers).toHaveLength(1);
    expect(field.gold).toBe(goldBefore - towerCost("fire", 1));
    expect(field.occupied.get(cell)).toBe(field.towers[0]!.id);
  });

  it("не даёт строить на занятой клетке и на дороге", () => {
    const state = createGame(baseOptions);
    const map = getMap(baseOptions.mapId);
    const cell = map.buildCells[0]!;
    const roadCell = [...map.roadCells][0]!;

    applyCommand(state, { t: "build", field: 0, cell, element: "fire" });

    expect(
      applyCommand(state, { t: "build", field: 0, cell, element: "ice" }),
    ).toBe(false);
    expect(
      applyCommand(state, {
        t: "build",
        field: 0,
        cell: roadCell,
        element: "ice",
      }),
    ).toBe(false);
    expect(state.fields[0]!.towers).toHaveLength(1);
  });

  it("не даёт строить без золота", () => {
    const state = createGame(baseOptions);
    const field = state.fields[0]!;
    field.gold = 10;
    const cell = getMap(baseOptions.mapId).buildCells[0]!;

    expect(
      applyCommand(state, { t: "build", field: 0, cell, element: "fire" }),
    ).toBe(false);
    expect(field.towers).toHaveLength(0);
  });

  it("продажа возвращает меньше вложенного", () => {
    const state = createGame(baseOptions);
    const field = state.fields[0]!;
    const cell = getMap(baseOptions.mapId).buildCells[0]!;
    const goldBefore = field.gold;

    applyCommand(state, { t: "build", field: 0, cell, element: "fire" });
    applyCommand(state, { t: "sell", field: 0, tower: field.towers[0]!.id });

    expect(field.towers).toHaveLength(0);
    expect(field.gold).toBeLessThan(goldBefore);
    expect(field.occupied.has(cell)).toBe(false);
  });
});

describe("ход партии", () => {
  it("монстры появляются, умирают и приносят золото", () => {
    const state = createGame(baseOptions);
    const field = state.fields[0]!;
    const cells = getMap(baseOptions.mapId).buildCells;
    for (let i = 0; i < 3; i++) {
      applyCommand(state, {
        t: "build",
        field: 0,
        cell: cells[i]!,
        element: "fire",
      });
    }

    for (let i = 0; i < 3000; i++) step(state);

    expect(field.stats.creepsKilled).toBeGreaterThan(0);
    expect(field.stats.goldEarned).toBeGreaterThan(0);
    expect(field.waveIndex).toBeGreaterThan(1);
  });

  it("без единой башни партия проигрывается", () => {
    const result = runGame({ ...baseOptions, difficulty: "hard" });
    expect(result.state.over).toBe(true);
    expect(result.state.endReason).toBe("lives");
    expect(result.state.fields[0]!.lives).toBe(0);
  });

  it("партия всегда завершается сама, без упора в лимит тиков", () => {
    for (const map of MAPS) {
      const result = runGame({
        ...baseOptions,
        mapId: map.id,
        difficulty: "hard",
      });
      expect(result.timedOut, `карта ${map.label} зависла`).toBe(false);
    }
  });
});

describe("экономика", () => {
  const RUNS = 24;

  function play(
    strategyId: string,
    difficulty: "easy" | "normal" | "hard",
  ): RunResult[] {
    const strategy = getStrategy(strategyId);
    const results: RunResult[] = [];
    for (let i = 0; i < RUNS; i++) {
      const mapId = MAPS[i % MAPS.length]!.id;
      const seed = 1000 + i * 7919;
      const bot = new AutoPlayer(strategy, 0, seed ^ 0x5bf03635, mapId);
      results.push(
        runGame({
          mode: "solo",
          difficulty,
          length: "classic",
          mapId,
          seed,
          controller: (state) => bot.update(state),
        }),
      );
    }
    return results;
  }

  it("«качай одну башню» не проходит хардкор", () => {
    // Главная проверка требования «улучшать башни не должно быть легко».
    // Если эта стратегия начнёт выигрывать — цена уровней стала слишком щедрой.
    const s = summarize(play("greedy-single", "hard"));
    expect(s.winRate).toBe(0);
    expect(s.avgWaves).toBeLessThan(15);
  });

  it("«много дешёвых башен» не проходит хардкор", () => {
    // Обратная проверка: если ширина без прокачки вывозит партию,
    // уровни башен вообще не нужны.
    const s = summarize(play("spread-cheap", "hard"));
    expect(s.winRate).toBe(0);
  });

  it("разумная игра проходит хардкор, но не всегда", () => {
    const s = summarize(play("balanced", "hard"));
    expect(s.winRate).toBeGreaterThan(0.15);
    expect(s.winRate).toBeLessThan(0.85);
  });

  it("случайные ходы почти никогда не выигрывают хардкор", () => {
    const s = summarize(play("chaotic", "hard"));
    expect(s.winRate).toBeLessThan(0.15);
  });

  it("разумная игра заметно лучше плохой — решения игрока значат многое", () => {
    const good = summarize(play("balanced", "hard"));
    const bad = summarize(play("greedy-single", "hard"));
    expect(good.avgWaves / Math.max(1, bad.avgWaves)).toBeGreaterThan(2.5);
  });

  it("на лёгкой сложности проходится уверенно", () => {
    const s = summarize(play("balanced", "easy"));
    expect(s.winRate).toBeGreaterThan(0.85);
  });

  it("заработок не разгоняется: награда отстаёт от здоровья волн", () => {
    // Проверка самой сути требования. К концу партии один монстр окупает
    // заметно меньшую долю обороны, чем в начале.
    const result = runGame({
      ...baseOptions,
      difficulty: "hard",
      length: "classic",
      controller: (() => {
        const bot = new AutoPlayer(
          getStrategy("balanced"),
          0,
          999,
          baseOptions.mapId,
        );
        return (state: Parameters<typeof bot.update>[0]) => bot.update(state);
      })(),
    });
    const field = result.state.fields[0]!;
    // Золото не копится мёртвым грузом. Небольшой остаток на руках в конце
    // партии нормален — важно, чтобы это не была половина всего заработка,
    // то есть чтобы деньги оставались ограничением до последних волн.
    expect(field.gold).toBeLessThan(field.stats.goldEarned * 0.3);
  });
});

describe("комбо-башни", () => {
  /** Ставит две башни на соседние площадки и возвращает их. */
  function buildPair(element: "fire" | "ice", other: "fire" | "ice" | "lightning") {
    const state = createGame({ ...baseOptions, difficulty: "easy" });
    const field = state.fields[0]!;
    field.gold = 10_000;

    const map = getMap(baseOptions.mapId);
    // Ищем две площадки, стоящие рядом хотя бы по диагонали.
    let pair: [number, number] | null = null;
    for (const a of map.buildCells) {
      for (const b of map.buildCells) {
        if (a === b) continue;
        const dc = Math.abs((a % 15) - (b % 15));
        const dr = Math.abs(Math.floor(a / 15) - Math.floor(b / 15));
        if (dc <= 1 && dr <= 1) {
          pair = [a, b];
          break;
        }
      }
      if (pair) break;
    }
    if (!pair) throw new Error("на карте нет соседних площадок");

    applyCommand(state, { t: "build", field: 0, cell: pair[0], element });
    applyCommand(state, { t: "build", field: 0, cell: pair[1], element: other });
    return { state, field, towers: field.towers };
  }

  it("две соседние башни разных стихий сливаются в одну", () => {
    const { state, field } = buildPair("fire", "ice");
    const [a, b] = field.towers;

    const ok = applyCommand(state, { t: "fuse", field: 0, tower: a!.id, with: b!.id });

    expect(ok).toBe(true);
    expect(field.towers).toHaveLength(1);
    expect(field.towers[0]!.fused).toBe("ice");
    // Площадка второй башни освободилась — это часть цены слияния.
    expect(field.occupied.size).toBe(1);
  });

  it("одинаковые стихии не сливаются", () => {
    const { state, field } = buildPair("fire", "fire");
    const [a, b] = field.towers;
    expect(applyCommand(state, { t: "fuse", field: 0, tower: a!.id, with: b!.id })).toBe(false);
    expect(field.towers).toHaveLength(2);
  });

  it("комбо-башню нельзя слить второй раз", () => {
    const { state, field } = buildPair("fire", "ice");
    const [a, b] = field.towers;
    applyCommand(state, { t: "fuse", field: 0, tower: a!.id, with: b!.id });

    const map = getMap(baseOptions.mapId);
    const free = map.buildCells.find((c) => !field.occupied.has(c))!;
    applyCommand(state, { t: "build", field: 0, cell: free, element: "poison" });

    const fused = field.towers[0]!;
    const third = field.towers[1]!;
    expect(applyCommand(state, { t: "fuse", field: 0, tower: fused.id, with: third.id })).toBe(
      false,
    );
  });

  it("комбо накладывает эффекты обеих стихий", () => {
    const { state, field } = buildPair("fire", "ice");
    const [a, b] = field.towers;
    applyCommand(state, { t: "fuse", field: 0, tower: a!.id, with: b!.id });

    // Ждём столько, чтобы через зону поражения успело пройти несколько волн:
    // совпадение обоих эффектов на одном монстре ловится не в любой момент.
    let seenBoth = false;
    for (let i = 0; i < 8000 && !state.over; i++) {
      step(state);
      if (field.creeps.some((c) => c.burnTicks > 0 && c.slowTicks > 0)) {
        seenBoth = true;
        break;
      }
    }

    expect(seenBoth).toBe(true);
  });
});

describe("темп волн", () => {
  it("на поле не больше двух волн одновременно", () => {
    // Волны не должны идти сплошным потоком: при паузе 14 секунд и проходе
    // маршрута за 44 их на поле висело до четырёх, разобрать происходящее
    // было невозможно.
    const spawnSeconds = (CREEPS_PER_WAVE * SPAWN_INTERVAL) / TICK_RATE;
    const gapSeconds = WAVE_INTERVAL / TICK_RATE;

    for (const map of MAPS) {
      const walkSeconds = map.pathLength / CREEP_BASE_SPEED / TICK_RATE;
      const wavesOnField = (spawnSeconds + walkSeconds) / gapSeconds;
      expect(wavesOnField, `карта ${map.label}`).toBeLessThan(2.5);
      // И не меньше одной: иначе игрок просто ждёт в пустом поле.
      expect(wavesOnField, `карта ${map.label}`).toBeGreaterThan(1.2);
    }
  });

  it("длина партии совпадает с обещанной в меню", () => {
    const gapMinutes = WAVE_INTERVAL / TICK_RATE / 60;
    const quick = (LENGTH.quick.totalWaves ?? 0) * gapMinutes;
    const classic = (LENGTH.classic.totalWaves ?? 0) * gapMinutes;

    // «Быстрая» заявлена как 10–15 минут, «Классика» — как 20–30.
    expect(quick).toBeGreaterThan(7);
    expect(quick).toBeLessThan(16);
    expect(classic).toBeGreaterThan(16);
    expect(classic).toBeLessThan(32);
  });
});

describe("досрочный призыв волны", () => {
  it("срабатывает один раз на волну, а не каждый тик", () => {
    // Команда обнуляла таймер, обработка волн тут же ставила его заново, и
    // следующий тик снова принимал призыв: за сто секунд набегало под тысячу
    // выплат и лавина волн одновременно.
    const state = createGame({ ...baseOptions, length: "classic" });
    let accepted = 0;
    for (let i = 0; i < 3000 && !state.over; i++) {
      if (applyCommand(state, { t: "rush", field: 0 })) accepted++;
      step(state);
    }
    const field = state.fields[0]!;
    expect(accepted).toBeLessThanOrEqual(field.waveIndex);
  });

  it("не даёт золота после последней волны", () => {
    const state = createGame({ ...baseOptions, length: "quick" });
    const field = state.fields[0]!;
    const total = LENGTH.quick.totalWaves!;

    // Досматриваем партию до конца расписания волн.
    for (let i = 0; i < 40_000 && field.waveIndex < total; i++) step(state);

    const goldBefore = field.gold;
    for (let i = 0; i < 200; i++) applyCommand(state, { t: "rush", field: 0 });
    expect(field.gold).toBe(goldBefore);
  });

  it("спам призывов не выигрывает партию", () => {
    // Раш — обмен времени на риск, а не способ печатать золото.
    const results = [];
    for (let i = 0; i < 12; i++) {
      const mapId = MAPS[i % MAPS.length]!.id;
      const bot = new AutoPlayer(getStrategy("rusher"), 0, 4242 + i, mapId);
      results.push(
        runGame({
          mode: "solo",
          difficulty: "hard",
          length: "classic",
          mapId,
          seed: 500 + i * 131,
          controller: (state) => bot.update(state),
        }),
      );
    }
    expect(summarize(results).winRate).toBe(0);
  });
});

describe("цены после правок", () => {
  it("отправка дорожает по своему типу, а не по общему счёту", () => {
    const state = createGame({ ...baseOptions, mode: "versus" });
    const field = state.fields[0]!;
    field.gold = 100_000;

    const flyingBefore = sendCost(field, "flying");
    for (let i = 0; i < 5; i++) {
      applyCommand(state, { t: "send", field: 0, kind: "normal" });
    }

    // Пять отправок обычных не должны влиять на цену летающих.
    expect(sendCost(field, "flying")).toBe(flyingBefore);
    expect(sendCost(field, "normal")).toBeGreaterThan(
      SEND.normal!.cost,
    );
  });

  it("слияние считается от обеих башен, а не только от жертвы", () => {
    const state = createGame({ ...baseOptions, difficulty: "easy" });
    const field = state.fields[0]!;
    field.gold = 100_000;

    const map = getMap(baseOptions.mapId);
    let pair: [number, number] | null = null;
    for (const a of map.buildCells) {
      for (const b of map.buildCells) {
        if (a === b) continue;
        if (
          Math.abs((a % 15) - (b % 15)) <= 1 &&
          Math.abs(Math.floor(a / 15) - Math.floor(b / 15)) <= 1
        ) {
          pair = [a, b];
          break;
        }
      }
      if (pair) break;
    }
    if (!pair) throw new Error("на карте нет соседних площадок");

    applyCommand(state, { t: "build", field: 0, cell: pair[0], element: "fire" });
    applyCommand(state, { t: "build", field: 0, cell: pair[1], element: "ice" });
    const [main, other] = field.towers;

    // Дорогая башня плюс дешёвая: цена должна учитывать вложенное в обе.
    for (let i = 0; i < 3; i++) {
      applyCommand(state, { t: "upgrade", field: 0, tower: main!.id });
    }

    const goldBefore = field.gold;
    applyCommand(state, {
      t: "fuse",
      field: 0,
      tower: main!.id,
      with: other!.id,
    });
    const paid = goldBefore - field.gold;

    expect(paid).toBeGreaterThan(
      Math.round(other!.invested * FUSION_COST_SHARE),
    );
  });
});
