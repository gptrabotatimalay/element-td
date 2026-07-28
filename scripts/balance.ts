/**
 * Прогон баланса. Запуск: npm run balance
 *
 * Играет каждой стратегией на каждой сложности много партий и печатает свод.
 * Смотреть надо не на «проходится ли игра», а на разброс между стратегиями:
 * если умная и глупая игра дают одинаковый результат — решения игрока ни на
 * что не влияют, и это худшая из возможных поломок баланса.
 */

import { AutoPlayer, STRATEGIES, type Strategy } from "../src/ai/strategies";
import { MAPS } from "../src/core/map";
import { runGame, summarize, type RunResult } from "../src/core/runner";
import type { Difficulty, MatchLength } from "../src/core/types";

const RUNS_PER_CASE = Number(process.env.RUNS ?? 40);
const LENGTHS: MatchLength[] = (process.env.LENGTH?.split(
  ",",
) as MatchLength[]) ?? ["classic"];
const DIFFICULTIES: Difficulty[] = (process.env.DIFF?.split(
  ",",
) as Difficulty[]) ?? ["easy", "normal", "hard"];

function runSeries(
  strategy: Strategy,
  difficulty: Difficulty,
  length: MatchLength,
  runs: number,
): RunResult[] {
  const results: RunResult[] = [];
  for (let i = 0; i < runs; i++) {
    const mapId = MAPS[i % MAPS.length]!.id;
    const seed = 1000 + i * 7919;
    const bot = new AutoPlayer(strategy, 0, seed ^ 0x5bf03635, mapId);
    results.push(
      runGame({
        mode: "solo",
        difficulty,
        length,
        mapId,
        seed,
        controller: (state) => bot.update(state),
      }),
    );
  }
  return results;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`.padStart(5);
}

function main(): void {
  const started = Date.now();

  for (const length of LENGTHS) {
    for (const difficulty of DIFFICULTIES) {
      console.log(
        `\n═══ ${length} / ${difficulty} — по ${RUNS_PER_CASE} партий ═══`,
      );
      console.log(
        "стратегия".padEnd(22) +
          "побед".padStart(6) +
          "волн ср.".padStart(10) +
          "мин".padStart(6) +
          "макс".padStart(6) +
          "зависло".padStart(9),
      );

      const rows: { strategy: Strategy; winRate: number; avgWaves: number }[] =
        [];

      for (const strategy of STRATEGIES) {
        const results = runSeries(strategy, difficulty, length, RUNS_PER_CASE);
        const s = summarize(results);
        rows.push({ strategy, winRate: s.winRate, avgWaves: s.avgWaves });
        console.log(
          strategy.label.padEnd(22) +
            pct(s.winRate).padStart(6) +
            s.avgWaves.toFixed(1).padStart(10) +
            String(s.minWaves).padStart(6) +
            String(s.maxWaves).padStart(6) +
            String(s.timeouts).padStart(9),
        );
      }

      const best = rows.reduce((a, b) => (b.avgWaves > a.avgWaves ? b : a));
      const worst = rows.reduce((a, b) => (b.avgWaves < a.avgWaves ? b : a));
      const spread =
        worst.avgWaves === 0 ? Infinity : best.avgWaves / worst.avgWaves;
      console.log(
        `\nразброс между лучшей и худшей игрой: ×${spread.toFixed(2)} ` +
          `(${best.strategy.label} против ${worst.strategy.label})`,
      );
    }
  }

  console.log(`\nготово за ${((Date.now() - started) / 1000).toFixed(1)} с`);
}

main();
