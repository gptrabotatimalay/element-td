/**
 * Автоподбор экономики. Запуск: npx tsx scripts/tune.ts [сложность]
 *
 * Перебирает показатель награды и печатает, что получается. Смысл не в том,
 * чтобы найти значение, при котором игра «проходится» — а в том, чтобы найти
 * коридор, где разумная игра выигрывает иногда, а плохая не выигрывает никогда.
 *
 * Целевые ориентиры:
 *   разумная игра   30–65% побед — есть за что бороться, но не гарантия
 *   всё в одну башню   0% побед — иначе прокачка одной башни ломает игру
 *   случайные ходы    <10% побед — иначе решения игрока ничего не значат
 */

import { AutoPlayer, getStrategy } from "../src/ai/strategies";
import { DIFFICULTY } from "../src/core/balance";
import { MAPS } from "../src/core/map";
import { runGame, summarize } from "../src/core/runner";
import type { Difficulty } from "../src/core/types";

const difficulty = (process.argv[2] as Difficulty) ?? "hard";
const RUNS = Number(process.env.RUNS ?? 24);

const PROBES = [
  "balanced",
  "greedy-single",
  "chaotic",
  "spread-cheap",
  "mono-fire",
];

function winRate(strategyId: string): { rate: number; avgWaves: number } {
  const strategy = getStrategy(strategyId);
  const results = [];
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
  const s = summarize(results);
  return { rate: s.winRate, avgWaves: s.avgWaves };
}

const original = DIFFICULTY[difficulty].bountyExponent;

console.log(
  `подбор награды для сложности «${difficulty}», по ${RUNS} партий на точку`,
);
console.log(`текущее значение: ${original}\n`);
console.log(
  "награда".padEnd(9) +
    PROBES.map((p) => getStrategy(p).label.slice(0, 13).padStart(15)).join(""),
);

for (
  let exp = original;
  exp <= 1.02;
  exp = Math.round((exp + 0.02) * 100) / 100
) {
  DIFFICULTY[difficulty].bountyExponent = exp;
  const cells = PROBES.map((p) => {
    const r = winRate(p);
    return `${(r.rate * 100).toFixed(0)}% / ${r.avgWaves.toFixed(0)}в`.padStart(
      15,
    );
  });
  console.log(String(exp).padEnd(9) + cells.join(""));
}

DIFFICULTY[difficulty].bountyExponent = original;
console.log("\nв ячейке: процент побед / средняя волна");
