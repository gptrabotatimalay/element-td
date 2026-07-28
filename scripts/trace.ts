/**
 * Разбор одной партии по волнам. Запуск: npx tsx scripts/trace.ts [сложность] [стратегия]
 *
 * Нужен, когда свод по тысяче партий говорит «не проходится», но не говорит
 * почему. Здесь видно, на чём именно кончается партия: не хватило золота,
 * не хватило площадок, или конкретная волна пробивает оборону.
 */

import { AutoPlayer, getStrategy } from "../src/ai/strategies";
import {
  CREEP_KIND,
  LENGTH,
  TICK_RATE,
  WAVE_PATTERN,
} from "../src/core/balance";
import { createGame, step } from "../src/core/sim";
import { getMap } from "../src/core/map";
import type { Difficulty } from "../src/core/types";

const difficulty = (process.argv[2] as Difficulty) ?? "hard";
const strategyId = process.argv[3] ?? "balanced";
const mapId = process.argv[4] ?? "serpent";

const strategy = getStrategy(strategyId);
const map = getMap(mapId);
const state = createGame({
  mode: "solo",
  difficulty,
  length: "classic",
  mapId,
  seed: 1337,
});
const bot = new AutoPlayer(strategy, 0, 4242, mapId);
const field = state.fields[0]!;

console.log(
  `${strategy.label} / ${difficulty} / ${map.label} — ${map.buildCells.length} площадок\n`,
);
console.log(
  "волна".padStart(6) +
    "жизни".padStart(7) +
    "золото".padStart(8) +
    "башен".padStart(7) +
    "уровни".padStart(8) +
    "утекло".padStart(8) +
    "на поле".padStart(9) +
    "  тип волны / кто на поле",
);

let lastWave = 0;
let lastLeaked = 0;
const maxTicks = 60 * 60 * TICK_RATE;

for (let i = 0; i < maxTicks && !state.over; i++) {
  step(state, bot.update(state));

  if (field.waveIndex !== lastWave) {
    lastWave = field.waveIndex;
    const levels = field.towers.reduce((a, t) => a + t.level, 0);
    const mix = new Map<string, number>();
    for (const t of field.towers)
      mix.set(t.element, (mix.get(t.element) ?? 0) + 1);
    const mixText = [...mix.entries()].map(([e, n]) => `${e}:${n}`).join(" ");
    const kind = LENGTH.classic.bossWaves.includes(lastWave)
      ? "БОСС"
      : CREEP_KIND[
          WAVE_PATTERN[(lastWave - 1) % WAVE_PATTERN.length] ?? "normal"
        ].label;

    // Кто уже на поле в момент прихода новой волны. Если предыдущие волны
    // не успевают умереть, нагрузка складывается — и виновата не текущая волна.
    const onField = new Map<string, number>();
    for (const c of field.creeps)
      onField.set(c.kind, (onField.get(c.kind) ?? 0) + 1);
    const onFieldText =
      [...onField.entries()].map(([k, n]) => `${k}:${n}`).join(" ") || "—";

    console.log(
      `${String(lastWave).padStart(6)}${String(field.lives).padStart(7)}` +
        `${String(Math.round(field.gold)).padStart(8)}${String(field.towers.length).padStart(7)}` +
        `${String(levels).padStart(8)}${String(field.stats.creepsLeaked - lastLeaked).padStart(8)}` +
        `${String(field.creeps.length).padStart(9)}` +
        `  ${kind.padEnd(14)} ${onFieldText}   [${mixText}]`,
    );
    lastLeaked = field.stats.creepsLeaked;
  }
}

console.log(
  `\nитог: ${state.endReason}, пережито волн ${field.stats.wavesSurvived}, ` +
    `убито ${field.stats.creepsKilled}, утекло ${field.stats.creepsLeaked}`,
);
console.log(
  `золота заработано ${Math.round(field.stats.goldEarned)}, ` +
    `потрачено ${Math.round(field.stats.goldSpent)}, осталось ${Math.round(field.gold)}`,
);
console.log(
  `площадок занято ${field.towers.length} из ${map.buildCells.length}, ` +
    `свободных ${map.buildCells.length - field.towers.length}`,
);
