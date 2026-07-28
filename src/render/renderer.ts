/**
 * Отрисовка поля.
 *
 * Рендер только читает состояние симуляции и никогда его не меняет — иначе
 * партия на телефоне и на ноутбуке разойдутся, а вместе с ними сетевая игра.
 *
 * Симуляция идёт 30 раз в секунду, экран обновляется 60 — поэтому позиции
 * монстров сглаживаются между двумя последними тиками.
 */

import { FIELD_HEIGHT, FIELD_WIDTH, towerRange } from "../core/balance";
import {
  CELL_SIZE,
  cellCenter,
  cellCol,
  cellRow,
  type GameMap,
} from "../core/map";
import type { Creep, Field } from "../core/types";
import { PALETTE, ELEMENT_COLORS } from "./palette";
import {
  CREEP_PX,
  creepSprite,
  tileSprite,
  tileVariant,
  towerSprite,
} from "./sprites";

export interface ViewTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface RenderOptions {
  /** Клетка под курсором — подсвечивается. */
  hoverCell: number | null;
  /** Выбранная башня — показывается её радиус. */
  selectedTowerId: number | null;
  /** Радиус будущей башни при выборе места. */
  previewRange: number | null;
  /** Доля времени до следующего тика симуляции, 0..1. */
  alpha: number;
}

/** Запомненные позиции прошлого тика — нужны только для сглаживания. */
type PrevPositions = Map<number, { x: number; y: number }>;

export class FieldRenderer {
  private prev: PrevPositions = new Map();
  private lastTick = -1;

  constructor(private readonly ctx: CanvasRenderingContext2D) {}

  /** Пересчёт масштаба под текущий размер холста, с полями по краям. */
  static fit(canvasWidth: number, canvasHeight: number): ViewTransform {
    const scale = Math.min(
      canvasWidth / FIELD_WIDTH,
      canvasHeight / FIELD_HEIGHT,
    );
    return {
      scale,
      offsetX: (canvasWidth - FIELD_WIDTH * scale) / 2,
      offsetY: (canvasHeight - FIELD_HEIGHT * scale) / 2,
    };
  }

  /** Экранные координаты → игровые. Нужно для кликов и касаний. */
  static toField(
    view: ViewTransform,
    screenX: number,
    screenY: number,
  ): { x: number; y: number } {
    return {
      x: (screenX - view.offsetX) / view.scale,
      y: (screenY - view.offsetY) / view.scale,
    };
  }

  draw(
    field: Field,
    map: GameMap,
    view: ViewTransform,
    tick: number,
    options: RenderOptions,
  ): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.translate(view.offsetX, view.offsetY);
    ctx.scale(view.scale, view.scale);

    this.drawGround(map);
    this.drawPads(map, options.hoverCell);
    this.drawRanges(field, options);
    this.drawTowers(field);
    this.drawCreeps(field, tick, options.alpha);
    this.drawProjectiles(field);

    ctx.restore();
  }

  private drawGround(map: GameMap): void {
    const ctx = this.ctx;
    for (let row = 0; row < FIELD_HEIGHT / CELL_SIZE; row++) {
      for (let col = 0; col < FIELD_WIDTH / CELL_SIZE; col++) {
        const cell = row * (FIELD_WIDTH / CELL_SIZE) + col;
        const isRoad = map.roadCells.has(cell);
        const sprite = tileSprite(isRoad ? "road" : "grass", tileVariant(cell));
        ctx.drawImage(
          sprite,
          col * CELL_SIZE,
          row * CELL_SIZE,
          CELL_SIZE,
          CELL_SIZE,
        );
      }
    }

    // Вход и база — самые важные точки на поле, помечаем явно.
    const start = map.path[0]!;
    const end = map.path[map.path.length - 1]!;
    this.drawPortal(start.x, start.y, PALETTE.blood);
    this.drawBase(end.x, end.y);
  }

  private drawPortal(x: number, y: number, color: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = PALETTE.ink;
    ctx.beginPath();
    ctx.arc(x, y, 11, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawBase(x: number, y: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = PALETTE.stoneDark;
    ctx.fillRect(x - 22, y - 22, 44, 44);
    ctx.fillStyle = PALETTE.stone;
    ctx.fillRect(x - 18, y - 18, 36, 36);
    ctx.fillStyle = PALETTE.gold;
    ctx.fillRect(x - 8, y - 8, 16, 16);
  }

  private drawPads(map: GameMap, hoverCell: number | null): void {
    const ctx = this.ctx;
    for (const cell of map.buildCells) {
      const col = cellCol(cell);
      const row = cellRow(cell);
      const sprite = tileSprite("pad", 0);
      ctx.drawImage(
        sprite,
        col * CELL_SIZE,
        row * CELL_SIZE,
        CELL_SIZE,
        CELL_SIZE,
      );
    }

    if (hoverCell !== null && map.buildSet.has(hoverCell)) {
      const col = cellCol(hoverCell);
      const row = cellRow(hoverCell);
      ctx.strokeStyle = PALETTE.padGlow;
      ctx.lineWidth = 3;
      ctx.strokeRect(
        col * CELL_SIZE + 2,
        row * CELL_SIZE + 2,
        CELL_SIZE - 4,
        CELL_SIZE - 4,
      );
    }
  }

  private drawRanges(field: Field, options: RenderOptions): void {
    const ctx = this.ctx;

    if (options.selectedTowerId !== null) {
      const tower = field.towers.find((t) => t.id === options.selectedTowerId);
      if (tower && tower.element !== "light") {
        const aura = field.auraCache.get(tower.id);
        const range =
          towerRange(tower.element, tower.level) * (aura?.rangeMult ?? 1);
        this.drawRangeCircle(
          tower.x,
          tower.y,
          range,
          ELEMENT_COLORS[tower.element][2],
        );
      }
    }

    if (options.previewRange !== null && options.hoverCell !== null) {
      const center = cellCenter(options.hoverCell);
      this.drawRangeCircle(
        center.x,
        center.y,
        options.previewRange,
        PALETTE.padGlow,
      );
    }

    ctx.lineWidth = 1;
  }

  private drawRangeCircle(
    x: number,
    y: number,
    radius: number,
    color: string,
  ): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  private drawTowers(field: Field): void {
    const ctx = this.ctx;
    for (const tower of field.towers) {
      const sprite = towerSprite(tower.element, tower.level, tower.fused);
      const size = CELL_SIZE;
      ctx.drawImage(sprite, tower.x - size / 2, tower.y - size / 2, size, size);
    }
  }

  private drawCreeps(field: Field, tick: number, alpha: number): void {
    const next: PrevPositions = new Map();
    const isNewTick = tick !== this.lastTick;

    for (const creep of field.creeps) {
      const prev = this.prev.get(creep.id);
      // Первый кадр жизни монстра сглаживать не с чем — рисуем как есть.
      const x = prev ? prev.x + (creep.x - prev.x) * alpha : creep.x;
      const y = prev ? prev.y + (creep.y - prev.y) * alpha : creep.y;

      this.drawCreep(creep, x, y);
      next.set(
        creep.id,
        isNewTick
          ? { x: creep.x, y: creep.y }
          : (prev ?? { x: creep.x, y: creep.y }),
      );
    }

    if (isNewTick) {
      this.prev = next;
      this.lastTick = tick;
    }
  }

  private drawCreep(creep: Creep, x: number, y: number): void {
    const ctx = this.ctx;
    const scale =
      creep.kind === "boss" ? 5.2 : creep.kind === "swarm" ? 2.8 : 3.8;
    const size = CREEP_PX * scale;

    // Летящие рисуются с тенью — иначе непонятно, почему по ним не стреляют.
    if (creep.flying) {
      ctx.save();
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = PALETTE.ink;
      ctx.beginPath();
      ctx.ellipse(
        x,
        y + size * 0.45,
        size * 0.35,
        size * 0.14,
        0,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      ctx.restore();
    }

    ctx.drawImage(
      creepSprite(creep.kind),
      x - size / 2,
      y - size / 2 - (creep.flying ? 8 : 0),
      size,
      size,
    );

    this.drawStatusTint(creep, x, y, size);
    this.drawHealthBar(creep, x, y, size);
  }

  /** Наложение цвета по действующему эффекту: заморозка, яд, горение. */
  private drawStatusTint(
    creep: Creep,
    x: number,
    y: number,
    size: number,
  ): void {
    const ctx = this.ctx;
    let color: string | null = null;
    let strength = 0;

    if (creep.freezeTicks > 0) {
      color = ELEMENT_COLORS.ice[2];
      strength = 0.5;
    } else if (creep.poisonStacks > 0) {
      color = ELEMENT_COLORS.poison[2];
      strength = 0.12 + Math.min(0.3, creep.poisonStacks * 0.06);
    } else if (creep.burnTicks > 0) {
      color = ELEMENT_COLORS.fire[2];
      strength = 0.28;
    } else if (creep.slowTicks > 0) {
      color = ELEMENT_COLORS.ice[1];
      strength = 0.2;
    }

    if (!color) return;
    ctx.save();
    ctx.globalAlpha = strength;
    ctx.fillStyle = color;
    ctx.fillRect(
      x - size / 2,
      y - size / 2 - (creep.flying ? 8 : 0),
      size,
      size,
    );
    ctx.restore();
  }

  private drawHealthBar(
    creep: Creep,
    x: number,
    y: number,
    size: number,
  ): void {
    if (creep.hp >= creep.maxHp) return;
    const ctx = this.ctx;
    const width = Math.max(20, size * 0.7);
    const top = y - size / 2 - (creep.flying ? 14 : 6);
    const ratio = Math.max(0, creep.hp / creep.maxHp);

    ctx.fillStyle = PALETTE.ink;
    ctx.fillRect(x - width / 2 - 1, top - 1, width + 2, 5);
    ctx.fillStyle =
      ratio > 0.5 ? "#5ac85a" : ratio > 0.25 ? PALETTE.gold : PALETTE.blood;
    ctx.fillRect(x - width / 2, top, width * ratio, 3);
  }

  private drawProjectiles(field: Field): void {
    const ctx = this.ctx;
    for (const p of field.projectiles) {
      const colors = ELEMENT_COLORS[p.element];
      ctx.fillStyle = colors[2];
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.splash > 0 ? 6 : 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = colors[3];
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.splash > 0 ? 3 : 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
