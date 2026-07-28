/**
 * Карты: маршрут монстров и клетки под башни.
 *
 * Путь задаётся вручную поворотными точками в клетках — так карта читается
 * глазами и не зависит от поиска пути. Мазинга в игре нет: игрок маршрут не
 * меняет, поэтому путь можно посчитать один раз при старте партии.
 *
 * Клетки под башни выводятся из маршрута автоматически — это всё, что
 * примыкает к дороге. Ограничение по количеству клеток намеренное: когда
 * места заканчиваются, игрок вынужден выбирать между новой башней и уровнем.
 */

import { FIELD_HEIGHT, FIELD_WIDTH } from "./balance";

export const CELL_SIZE = 64;
export const GRID_COLS = FIELD_WIDTH / CELL_SIZE; // 15
export const GRID_ROWS = FIELD_HEIGHT / CELL_SIZE; // 10

export interface Point {
  x: number;
  y: number;
}

export interface GameMap {
  id: string;
  label: string;
  /** Поворотные точки маршрута в координатах клеток. */
  waypoints: Point[];
  /** Готовый маршрут в игровых юнитах — центры клеток на поворотах. */
  path: Point[];
  /** Полная длина маршрута в юнитах. */
  pathLength: number;
  /** Накопленная длина до каждой точки — чтобы искать позицию по прогрессу. */
  cumulative: number[];
  /** Индексы клеток, занятых дорогой. */
  roadCells: Set<number>;
  /** Индексы клеток, где можно строить. */
  buildCells: number[];
  /** То же самое множеством — проверка при постройке идёт на каждый клик. */
  buildSet: Set<number>;
}

export function cellIndex(col: number, row: number): number {
  return row * GRID_COLS + col;
}

export function cellCol(index: number): number {
  return index % GRID_COLS;
}

export function cellRow(index: number): number {
  return Math.floor(index / GRID_COLS);
}

/** Центр клетки в игровых юнитах. */
export function cellCenter(index: number): Point {
  return {
    x: cellCol(index) * CELL_SIZE + CELL_SIZE / 2,
    y: cellRow(index) * CELL_SIZE + CELL_SIZE / 2,
  };
}

/** Все клетки дороги между двумя поворотами включительно. */
function fillSegment(from: Point, to: Point, out: Set<number>): void {
  const dx = Math.sign(to.x - from.x);
  const dy = Math.sign(to.y - from.y);
  let { x, y } = from;
  out.add(cellIndex(x, y));
  while (x !== to.x || y !== to.y) {
    x += dx;
    y += dy;
    out.add(cellIndex(x, y));
  }
}

function buildMap(id: string, label: string, waypoints: Point[]): GameMap {
  const roadCells = new Set<number>();
  for (let i = 0; i < waypoints.length - 1; i++) {
    fillSegment(waypoints[i]!, waypoints[i + 1]!, roadCells);
  }

  const path = waypoints.map((w) => ({
    x: w.x * CELL_SIZE + CELL_SIZE / 2,
    y: w.y * CELL_SIZE + CELL_SIZE / 2,
  }));

  const cumulative: number[] = [0];
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    total += Math.hypot(b.x - a.x, b.y - a.y);
    cumulative.push(total);
  }

  // Площадки под башни — вплотную к дороге, но в шахматном порядке.
  //
  // Шахматка здесь не для красоты. Если разрешить строить на каждой свободной
  // клетке, площадок выходит под две сотни, место перестаёт быть ресурсом и
  // единственным ограничением остаётся золото. Тогда прокачка уровней теряет
  // смысл: всегда выгоднее поставить ещё одну дешёвую башню. Половина клеток
  // даёт примерно три десятка площадок — они кончаются к середине партии,
  // и игрок вынужден переходить от ширины к глубине.
  const buildSet = new Set<number>();
  for (const cell of roadCells) {
    const col = cellCol(cell);
    const row = cellRow(cell);
    for (let dc = -1; dc <= 1; dc++) {
      for (let dr = -1; dr <= 1; dr++) {
        const c = col + dc;
        const r = row + dr;
        if (c < 0 || c >= GRID_COLS || r < 0 || r >= GRID_ROWS) continue;
        if ((c + r) % 2 !== 0) continue;
        const idx = cellIndex(c, r);
        if (roadCells.has(idx)) continue;
        buildSet.add(idx);
      }
    }
  }

  const buildCells = [...buildSet].sort((a, b) => a - b);

  return {
    id,
    label,
    waypoints,
    path,
    pathLength: total,
    cumulative,
    roadCells,
    buildCells,
    buildSet,
  };
}

const p = (x: number, y: number): Point => ({ x, y });

// Сетка 15×10. Между витками маршрута оставлено два свободных ряда.
//
// Один ряд, как было сначала, выглядел компактнее, но делал слияние башен
// невозможным: площадки в шахматном порядке внутри единственного ряда никогда
// не оказываются рядом, а соседние ряды заняты дорогой. Механика комбо была бы
// в игре и не работала бы ни разу. Два ряда дают и соседей по диагонали,
// и место для аур позади линии огня.
export const MAPS: GameMap[] = [
  buildMap("serpent", "Змейка", [
    p(0, 1),
    p(13, 1),
    p(13, 4),
    p(1, 4),
    p(1, 7),
    p(13, 7),
    p(13, 9),
    p(7, 9),
  ]),
  buildMap("spiral", "Спираль", [
    p(0, 0),
    p(14, 0),
    p(14, 9),
    p(1, 9),
    p(1, 3),
    p(11, 3),
    p(11, 6),
    p(5, 6),
  ]),
  // Зигзаг сначала был заметно короче и беднее площадками, чем остальные две
  // карты. В прогонах это выглядело не как «сложная карта», а как поломка
  // баланса: одна и та же стратегия проходила две карты из трёх и стабильно
  // валилась на третьей. Четыре зуба вместо трёх выравнивают её с остальными.
  buildMap("zigzag", "Зигзаг", [
    p(0, 1),
    p(2, 1),
    p(2, 8),
    p(5, 8),
    p(5, 1),
    p(8, 1),
    p(8, 8),
    p(11, 8),
    p(11, 1),
    p(14, 1),
    p(14, 6),
    p(9, 6),
  ]),
];

export function getMap(id: string): GameMap {
  return MAPS.find((m) => m.id === id) ?? MAPS[0]!;
}

/**
 * Позиция на маршруте по пройденному расстоянию.
 * Если расстояние больше длины пути — вернётся конечная точка.
 */
export function pointAtProgress(map: GameMap, progress: number): Point {
  if (progress <= 0) return map.path[0]!;
  if (progress >= map.pathLength) return map.path[map.path.length - 1]!;

  // Отрезков мало (меньше десятка), линейный поиск дешевле бинарного.
  let seg = 0;
  while (
    seg < map.cumulative.length - 2 &&
    map.cumulative[seg + 1]! <= progress
  )
    seg++;

  const a = map.path[seg]!;
  const b = map.path[seg + 1]!;
  const segStart = map.cumulative[seg]!;
  const segLength = map.cumulative[seg + 1]! - segStart;
  const t = segLength === 0 ? 0 : (progress - segStart) / segLength;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/**
 * Маршрут летающих: по прямой от входа к базе, срезая весь лабиринт.
 * Поэтому они опасны и поэтому им намеренно занижена скорость в balance.ts.
 */
export function airPath(map: GameMap): {
  from: Point;
  to: Point;
  length: number;
} {
  const from = map.path[0]!;
  const to = map.path[map.path.length - 1]!;
  return { from, to, length: Math.hypot(to.x - from.x, to.y - from.y) };
}
