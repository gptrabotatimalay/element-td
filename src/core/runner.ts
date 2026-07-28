/**
 * Прогон партии без браузера.
 *
 * Это то, ради чего симуляция отделена от картинки: партию можно сыграть в
 * Node за миллисекунды и повторить тысячу раз с разными сидами. Без такого
 * прогона баланс проверяется только руками и только на глаз — а значит никак.
 */

import { LENGTH, TICK_RATE } from "./balance";
import { createGame, step, type GameOptions } from "./sim";
import type { Command, Difficulty, GameState, MatchLength } from "./types";

export interface RunResult {
  state: GameState;
  /** Сколько волн пережило поле каждого игрока. */
  wavesSurvived: number[];
  /** true — симуляция упёрлась в лимит тиков, а не закончилась сама. */
  timedOut: boolean;
  ticks: number;
}

export interface RunOptions extends GameOptions {
  /** Источник команд на каждый тик. Обычно это боты. */
  controller?: (state: GameState) => Command[];
  /** Предохранитель от зависшей партии. */
  maxTicks?: number;
}

/** Разумный лимит тиков для длины партии, с большим запасом. */
export function defaultMaxTicks(length: MatchLength): number {
  const waves = LENGTH[length].totalWaves ?? 60;
  // Волна плюс её зачистка укладываются секунд в тридцать; берём вчетверо больше.
  return waves * 30 * TICK_RATE * 4;
}

export function runGame(options: RunOptions): RunResult {
  const state = createGame(options);
  const maxTicks = options.maxTicks ?? defaultMaxTicks(options.length);

  let ticks = 0;
  while (!state.over && ticks < maxTicks) {
    const commands = options.controller ? options.controller(state) : [];
    step(state, commands);
    ticks++;
  }

  return {
    state,
    wavesSurvived: state.fields.map((f) => f.stats.wavesSurvived),
    timedOut: !state.over,
    ticks,
  };
}

export interface BatchSummary {
  runs: number;
  wins: number;
  winRate: number;
  avgWaves: number;
  minWaves: number;
  maxWaves: number;
  timeouts: number;
}

/** Свод по серии партий — то, на что смотрят при настройке баланса. */
export function summarize(results: RunResult[], playerIndex = 0): BatchSummary {
  const waves = results.map((r) => r.wavesSurvived[playerIndex] ?? 0);
  const wins = results.filter((r) => r.state.winner === playerIndex).length;
  return {
    runs: results.length,
    wins,
    winRate: results.length === 0 ? 0 : wins / results.length,
    avgWaves: waves.reduce((a, b) => a + b, 0) / Math.max(1, waves.length),
    minWaves: Math.min(...waves),
    maxWaves: Math.max(...waves),
    timeouts: results.filter((r) => r.timedOut).length,
  };
}

export const DIFFICULTIES: Difficulty[] = ["easy", "normal", "hard"];
