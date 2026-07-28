/**
 * Оценка клеток: сколько маршрута простреливается из этой клетки.
 *
 * Нужна и боту (куда ставить), и подсказкам игроку. Считается один раз на карту
 * и кэшируется — маршрут не меняется, потому что мазинга в игре нет.
 */

import { towerRange } from "../core/balance";
import { cellCenter, pointAtProgress, type GameMap } from "../core/map";

/** Шаг дискретизации маршрута при оценке, в юнитах. */
const SAMPLE_STEP = 20;

const cache = new Map<string, Map<number, number>>();

/**
 * Для каждой клетки под застройку — доля маршрута в радиусе.
 * Радиус берётся от средней башни первого уровня: точные значения по стихиям
 * отличаются мало, а пересчитывать на каждую стихию незачем.
 */
export function coverageMap(map: GameMap): Map<number, number> {
  const cached = cache.get(map.id);
  if (cached) return cached;

  const range = towerRange("fire", 1);
  const rangeSq = range * range;

  const samples: { x: number; y: number }[] = [];
  for (let d = 0; d <= map.pathLength; d += SAMPLE_STEP) {
    samples.push(pointAtProgress(map, d));
  }

  const result = new Map<number, number>();
  for (const cell of map.buildCells) {
    const center = cellCenter(cell);
    let count = 0;
    for (const s of samples) {
      const dx = s.x - center.x;
      const dy = s.y - center.y;
      if (dx * dx + dy * dy <= rangeSq) count++;
    }
    result.set(cell, count / samples.length);
  }

  cache.set(map.id, result);
  return result;
}

/** Клетки под застройку, отсортированные от лучшей к худшей. */
export function rankedCells(map: GameMap): number[] {
  const coverage = coverageMap(map);
  return [...map.buildCells].sort((a, b) => {
    const diff = (coverage.get(b) ?? 0) - (coverage.get(a) ?? 0);
    // При равном покрытии — по индексу, чтобы порядок был детерминированным.
    return diff !== 0 ? diff : a - b;
  });
}
