/**
 * Пиксель-арт, нарисованный кодом.
 *
 * Почему не готовые картинки и не генерация нейросетью: спрайты рисуются
 * попиксельно в маленький холст и растягиваются без сглаживания — значит это
 * настоящие пиксели, а не размытая имитация. Плюс ничего не грузится по сети:
 * нет ни ожидания, ни отсутствующих файлов, ни рассинхрона стилей между
 * башнями из разных наборов.
 *
 * Каждый спрайт рисуется один раз при запуске и кладётся в кэш.
 */

import type { CreepKind, ElementId } from "../core/types";
import { ELEMENT_COLORS, PALETTE } from "./palette";

/** Сторона спрайта башни в пикселях. Клетка 64 юнита — ровно ×4. */
export const TOWER_PX = 16;
/** Сторона спрайта монстра. */
export const CREEP_PX = 12;

type Canvas = HTMLCanvasElement;

function makeCanvas(size: number): {
  canvas: Canvas;
  ctx: CanvasRenderingContext2D;
} {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  return { canvas, ctx };
}

function px(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, 1, 1);
}

function rect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

/** Симметричная относительно вертикальной оси заливка — башни всегда ровные. */
function mirrorRect(
  ctx: CanvasRenderingContext2D,
  size: number,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
): void {
  rect(ctx, x, y, w, h, color);
  rect(ctx, size - x - w, y, w, h, color);
}

// ─────────────────────────────────────────────────────────────────────────────
// Башни
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Башня строится из трёх ярусов: каменное основание, корпус цвета стихии и
 * навершие. С уровнем корпус вытягивается вверх, добавляются зубцы, кристалл
 * и свечение — уровень должно быть видно с одного взгляда, без чтения цифр.
 */
function drawTower(
  ctx: CanvasRenderingContext2D,
  element: ElementId,
  level: number,
  fused: ElementId | null = null,
): void {
  const [dark, main, light, glow] = ELEMENT_COLORS[element];
  const S = TOWER_PX;

  // Силуэт классической башни: широкое каменное основание, сужающийся кверху
  // ствол, крыша цвета стихии. Плоский брусок во всю клетку читался как ящик,
  // а не как постройка — от вида сверху всё равно нужен намёк на высоту.

  // Свет не стреляет, поэтому и башней не выглядит: это низкий алтарь.
  if (element === "light") {
    rect(ctx, 1, 9, 14, 6, PALETTE.stoneDark);
    rect(ctx, 2, 10, 12, 4, PALETTE.stone);
    rect(ctx, 2, 10, 12, 1, PALETTE.stoneLight);
    mirrorRect(ctx, S, 2, 6, 2, 5, light);
    mirrorRect(ctx, S, 2, 5, 2, 1, glow);
    rect(
      ctx,
      6,
      4 - Math.min(2, level - 1),
      4,
      7 + Math.min(2, level - 1),
      main,
    );
    rect(
      ctx,
      7,
      5 - Math.min(2, level - 1),
      2,
      5 + Math.min(2, level - 1),
      glow,
    );
    if (level >= 4) rect(ctx, 5, 2, 6, 1, glow);
    return;
  }

  // Основание.
  rect(ctx, 1, 11, 14, 5, PALETTE.stoneDark);
  rect(ctx, 2, 11, 12, 4, PALETTE.stone);
  rect(ctx, 2, 11, 12, 1, PALETTE.stoneLight);

  // Ствол: чем выше уровень, тем выше и стройнее.
  const shaftTop = 9 - level;
  rect(ctx, 3, shaftTop, 10, 11 - shaftTop, PALETTE.stoneDark);
  rect(ctx, 4, shaftTop, 8, 11 - shaftTop, PALETTE.stone);
  rect(ctx, 4, shaftTop, 2, 11 - shaftTop, PALETTE.stoneLight);

  // Бойница — по ней видно, куда смотрит башня.
  rect(ctx, 6, shaftTop + 2, 4, 3, PALETTE.ink);
  rect(ctx, 7, shaftTop + 3, 2, 2, dark);

  // Крыша цвета стихии, ступенчатая — так читается как конус.
  const roofBase = shaftTop - 1;
  rect(ctx, 2, roofBase, 12, 2, dark);
  rect(ctx, 3, roofBase - 1, 10, 1, main);
  rect(ctx, 4, roofBase - 2, 8, 1, main);
  rect(ctx, 5, roofBase - 3, 6, 1, light);
  rect(ctx, 3, roofBase, 10, 1, light);

  // У комбо-башни вторая стихия проступает второй половиной крыши —
  // так пара читается с одного взгляда, без наведения на башню.
  if (fused) {
    const [, fusedMain, fusedLight] = ELEMENT_COLORS[fused];
    rect(ctx, 8, roofBase, 6, 2, fusedMain);
    rect(ctx, 8, roofBase - 1, 5, 1, fusedLight);
    rect(ctx, 8, roofBase - 2, 4, 1, fusedLight);
    rect(ctx, 10, shaftTop + 2, 2, 3, fusedMain);
  }

  // Зубцы по краям крыши — с третьего уровня.
  if (level >= 3) {
    mirrorRect(ctx, S, 1, roofBase, 2, 2, dark);
    mirrorRect(ctx, S, 1, roofBase - 1, 1, 1, main);
  }

  // Навершие: кристалл с четвёртого, свечение с пятого.
  if (level >= 4) {
    const top = Math.max(0, roofBase - 6);
    rect(ctx, 7, top, 2, 4, light);
    rect(ctx, 6, top + 1, 4, 2, glow);
    if (level >= 5) {
      mirrorRect(ctx, S, 4, top + 2, 1, 1, glow);
      rect(ctx, 7, Math.max(0, top - 1), 2, 1, glow);
    }
  }
}

const towerCache = new Map<string, Canvas>();

export function towerSprite(
  element: ElementId,
  level: number,
  fused: ElementId | null = null,
): Canvas {
  const key = `${element}:${level}:${fused ?? "-"}`;
  const cached = towerCache.get(key);
  if (cached) return cached;

  const { canvas, ctx } = makeCanvas(TOWER_PX);
  drawTower(ctx, element, level, fused);
  towerCache.set(key, canvas);
  return canvas;
}

// ─────────────────────────────────────────────────────────────────────────────
// Монстры
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Тип монстра должен читаться мгновенно и по силуэту, а не по цвету:
 * игрок смотрит на поле в движении, разбирать оттенки некогда.
 */
function drawCreep(ctx: CanvasRenderingContext2D, kind: CreepKind): void {
  const S = CREEP_PX;

  switch (kind) {
    case "normal": {
      rect(ctx, 3, 3, 6, 7, PALETTE.fleshDark);
      rect(ctx, 4, 4, 4, 5, PALETTE.flesh);
      rect(ctx, 4, 4, 4, 1, PALETTE.fleshLight);
      mirrorRect(ctx, S, 4, 5, 1, 1, PALETTE.eye);
      rect(ctx, 4, 10, 2, 2, PALETTE.fleshDark);
      rect(ctx, 6, 10, 2, 2, PALETTE.fleshDark);
      break;
    }
    case "fast": {
      // Узкий вытянутый силуэт — сразу видно, что бежит.
      rect(ctx, 4, 4, 4, 5, PALETTE.slime);
      rect(ctx, 5, 3, 2, 6, PALETTE.slimeLight);
      mirrorRect(ctx, S, 4, 5, 1, 1, PALETTE.eyeAngry);
      rect(ctx, 3, 9, 2, 1, PALETTE.slime);
      rect(ctx, 7, 9, 2, 1, PALETTE.slime);
      // Штрихи скорости сзади.
      px(ctx, 2, 5, PALETTE.slimeLight);
      px(ctx, 1, 6, PALETTE.slimeLight);
      break;
    }
    case "armored": {
      rect(ctx, 2, 3, 8, 8, PALETTE.armorPlate);
      rect(ctx, 3, 4, 6, 6, PALETTE.armorPlateLight);
      rect(ctx, 3, 4, 6, 1, PALETTE.boneLight);
      // Прорезь забрала.
      rect(ctx, 4, 6, 4, 1, PALETTE.ink);
      mirrorRect(ctx, S, 4, 6, 1, 1, PALETTE.eyeAngry);
      mirrorRect(ctx, S, 1, 5, 1, 3, PALETTE.armorPlate);
      break;
    }
    case "flying": {
      // Крылья шире тела — единственный силуэт с размахом в стороны.
      rect(ctx, 0, 4, 4, 2, PALETTE.wing);
      rect(ctx, 8, 4, 4, 2, PALETTE.wing);
      rect(ctx, 1, 3, 3, 1, PALETTE.wingLight);
      rect(ctx, 8, 3, 3, 1, PALETTE.wingLight);
      rect(ctx, 4, 3, 4, 6, PALETTE.fleshDark);
      rect(ctx, 5, 4, 2, 4, PALETTE.flesh);
      mirrorRect(ctx, S, 4, 5, 1, 1, PALETTE.eye);
      break;
    }
    case "swarm": {
      // Мелкий и круглый — их всегда толпа.
      rect(ctx, 4, 5, 4, 4, PALETTE.slime);
      rect(ctx, 5, 4, 2, 5, PALETTE.slime);
      rect(ctx, 5, 5, 2, 1, PALETTE.slimeLight);
      mirrorRect(ctx, S, 4, 6, 1, 1, PALETTE.eye);
      break;
    }
    case "boss": {
      rect(ctx, 1, 2, 10, 9, PALETTE.fleshDark);
      rect(ctx, 2, 3, 8, 7, PALETTE.flesh);
      rect(ctx, 2, 3, 8, 1, PALETTE.fleshLight);
      // Рога.
      mirrorRect(ctx, S, 1, 0, 1, 3, PALETTE.boneLight);
      mirrorRect(ctx, S, 2, 1, 1, 1, PALETTE.boneLight);
      mirrorRect(ctx, S, 3, 5, 2, 2, PALETTE.eyeAngry);
      rect(ctx, 4, 8, 4, 1, PALETTE.boneLight);
      break;
    }
  }
}

const creepCache = new Map<string, Canvas>();

export function creepSprite(kind: CreepKind): Canvas {
  const cached = creepCache.get(kind);
  if (cached) return cached;

  const { canvas, ctx } = makeCanvas(CREEP_PX);
  drawCreep(ctx, kind);
  creepCache.set(kind, canvas);
  return canvas;
}

// ─────────────────────────────────────────────────────────────────────────────
// Тайлы поля
// ─────────────────────────────────────────────────────────────────────────────

export type TileKind = "grass" | "road" | "pad";

/**
 * Тайлы делаются в нескольких вариантах и раскладываются по позиции клетки.
 * Один и тот же тайл на всём поле читается как пустая заливка, а не как земля.
 */
function drawTile(
  ctx: CanvasRenderingContext2D,
  kind: TileKind,
  variant: number,
): void {
  const S = 16;

  if (kind === "grass") {
    rect(ctx, 0, 0, S, S, PALETTE.grass);
    const spots = [
      [3, 4],
      [11, 7],
      [6, 12],
      [13, 2],
    ] as const;
    for (let i = 0; i <= variant; i++) {
      const spot = spots[i % spots.length]!;
      px(ctx, spot[0], spot[1], PALETTE.grassDark);
      px(ctx, spot[0] + 1, spot[1], PALETTE.grassLight);
    }
    return;
  }

  if (kind === "road") {
    rect(ctx, 0, 0, S, S, PALETTE.road);
    rect(ctx, 0, 0, S, 1, PALETTE.roadLight);
    const stones = [
      [2, 5, 3, 2],
      [9, 3, 2, 2],
      [6, 10, 3, 2],
      [12, 9, 2, 3],
    ] as const;
    for (let i = 0; i <= variant; i++) {
      const s = stones[i % stones.length]!;
      rect(ctx, s[0], s[1], s[2], s[3], PALETTE.roadDark);
      px(ctx, s[0], s[1], PALETTE.roadLight);
    }
    return;
  }

  // Площадка под башню. Раньше это была яркая плита во всю клетку — из-за неё
  // всё поле выглядело шахматкой, а башни на её фоне терялись. Теперь плита
  // в тон траве, а место обозначено уголками: заметно, но внимание не тянет.
  rect(ctx, 2, 2, S - 4, S - 4, PALETTE.padDark);
  rect(ctx, 3, 3, S - 6, S - 6, PALETTE.pad);
  for (const [cx, cy] of [
    [2, 2],
    [S - 4, 2],
    [2, S - 4],
    [S - 4, S - 4],
  ] as const) {
    rect(ctx, cx, cy, 2, 1, PALETTE.padLight);
    rect(ctx, cx, cy, 1, 2, PALETTE.padLight);
  }
}

const tileCache = new Map<string, Canvas>();

export function tileSprite(kind: TileKind, variant: number): Canvas {
  const key = `${kind}:${variant}`;
  const cached = tileCache.get(key);
  if (cached) return cached;

  const { canvas, ctx } = makeCanvas(16);
  drawTile(ctx, kind, variant);
  tileCache.set(key, canvas);
  return canvas;
}

/** Стабильный вариант тайла по номеру клетки — картинка не мигает между кадрами. */
export function tileVariant(cell: number): number {
  return (cell * 2654435761) % 4;
}
