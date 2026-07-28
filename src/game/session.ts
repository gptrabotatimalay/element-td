/**
 * Игровая сессия: связывает симуляцию, экран и ввод.
 *
 * Симуляция всегда идёт фиксированными шагами по 30 в секунду, независимо от
 * частоты кадров. Иначе на телефоне со слабым экраном игра шла бы медленнее,
 * чем на ноутбуке, а по сети партии просто разъехались бы.
 */

import { AutoPlayer, getStrategy, type Strategy } from "../ai/strategies";
import { sound } from "../audio/sound";
import { ELEMENT, TICK_RATE, towerRange } from "../core/balance";
import {
  CELL_SIZE,
  GRID_COLS,
  cellIndex,
  getMap,
  type GameMap,
} from "../core/map";
import { createGame, step, type GameOptions } from "../core/sim";
import type { Command, ElementId, GameState } from "../core/types";
import type { RoomClient } from "../net/client";
import { encodeSnapshot, decodeField } from "../net/snapshot";
import type { Snapshot } from "../net/protocol";
import { EffectLayer } from "../render/effects";
import { FieldRenderer, type ViewTransform } from "../render/renderer";

const STEP_MS = 1000 / TICK_RATE;
/** Больше этого за кадр не досчитываем: после сворачивания вкладки не нужно
 *  проигрывать пропущенные минуты в ускоренной перемотке. */
const MAX_CATCHUP_STEPS = 6;

/**
 * Как часто хост рассылает снимок состояния.
 *
 * Не тридцать раз в секунду, а десять: движение между снимками всё равно
 * сглаживается на стороне гостя, а трафик втрое меньше — это заметно на
 * мобильном интернете, где играть и будут.
 */
const SNAPSHOT_EVERY_TICKS = 3;

/**
 * Роль в партии.
 *  local — обычная одиночная игра;
 *  host  — считает партию за обоих и рассылает состояние;
 *  guest — ничего не считает, рисует присланное и шлёт свои команды хосту.
 */
export type SessionRole = "local" | "host" | "guest";

export interface SessionCallbacks {
  onStateChange?: (state: GameState) => void;
  onGameOver?: (state: GameState) => void;
}

export interface NetworkSetup {
  role: SessionRole;
  client: RoomClient;
  /** Какое поле принадлежит этому клиенту. */
  field: number;
}

export type PlacementMode =
  { kind: "none" } | { kind: "build"; element: ElementId };

export class GameSession {
  readonly state: GameState;
  readonly map: GameMap;

  private renderer: FieldRenderer;
  private effects = new EffectLayer();
  private view: ViewTransform = {
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    rotated: false,
  };

  /**
   * Второй холст — поле соперника целиком, в уменьшенном виде.
   *
   * Раньше на чужое поле можно было только переключиться, потеряв из виду
   * своё. В версусе это неудобно: решение отправить монстров принимается
   * ровно тогда, когда видно и свою оборону, и чужую. Поэтому поле соперника
   * теперь всегда на экране рядом, а переключение осталось лишь для того,
   * чтобы рассмотреть его крупно.
   */
  private minimapCanvas: HTMLCanvasElement | null = null;
  private minimapRenderer: FieldRenderer | null = null;
  private minimapView: ViewTransform = {
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    rotated: false,
  };

  private accumulator = 0;
  private lastFrame = 0;
  private rafId: number | null = null;

  private bot: AutoPlayer | null = null;
  private pendingCommands: Command[] = [];

  private net: NetworkSetup | null = null;
  role: SessionRole = "local";
  /** Последний снимок от хоста — гость рисует именно его. */
  private lastSnapshotTick = -1;

  /**
   * Поле, которым управляет этот клиент. Команды всегда уходят сюда.
   * Отделено от просматриваемого: в версусе можно смотреть на соперника,
   * продолжая строить у себя.
   */
  ownField = 0;
  /** Поле, которое сейчас нарисовано на экране. */
  playerField = 0;
  placement: PlacementMode = { kind: "none" };
  hoverCell: number | null = null;
  selectedTowerId: number | null = null;
  paused = false;
  speed = 1;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    options: GameOptions,
    private readonly callbacks: SessionCallbacks = {},
    botStrategy?: Strategy | string,
  ) {
    this.state = createGame(options);
    this.map = getMap(options.mapId);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Холст не поддерживается этим браузером");
    this.renderer = new FieldRenderer(ctx);

    if (botStrategy) {
      const strategy =
        typeof botStrategy === "string"
          ? getStrategy(botStrategy)
          : botStrategy;
      // Бот всегда управляет вторым полем — первое за игроком.
      this.bot = new AutoPlayer(
        strategy,
        1,
        options.seed ^ 0x9e3779b9,
        options.mapId,
      );
    }

    this.resize();
  }

  start(): void {
    if (this.rafId !== null) return;
    this.lastFrame = performance.now();
    sound.startMusic();
    const loop = (now: number): void => {
      this.frame(now);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    sound.stopMusic();
  }

  /**
   * Подключает сессию к комнате. Хост начинает рассылать состояние,
   * гость перестаёт считать партию и переходит на присланные снимки.
   */
  attachNetwork(setup: NetworkSetup): void {
    this.net = setup;
    this.role = setup.role;
    this.ownField = setup.field;
    this.playerField = setup.field;
  }

  /** Снимок от хоста. Гость подменяет им своё состояние целиком. */
  applySnapshot(snapshot: Snapshot): void {
    if (this.role !== "guest") return;
    // Снимки могут прийти не по порядку — старые игнорируем, иначе
    // картинка будет дёргаться назад во времени.
    if (snapshot.tick <= this.lastSnapshotTick) return;
    this.lastSnapshotTick = snapshot.tick;

    this.state.tick = snapshot.tick;
    this.state.fields = snapshot.fields.map((field, index) => decodeField(field, index));

    const wasOver = this.state.over;
    this.state.over = snapshot.over;
    this.state.winner = snapshot.winner;

    if (!wasOver && snapshot.over) {
      sound.stopMusic();
      if (snapshot.winner === this.playerField) sound.victory();
      else sound.defeat();
      this.callbacks.onGameOver?.(this.state);
    }

    this.callbacks.onStateChange?.(this.state);
  }

  /**
   * Команда от игрока или из сети.
   *
   * У гостя команда не применяется на месте: считает только хост, поэтому
   * ход уходит по сети и вернётся уже готовым результатом в снимке.
   */
  enqueue(command: Command): void {
    if (this.role === "guest") {
      this.net?.client.sendCommand(command);
      return;
    }
    this.pendingCommands.push(command);
  }

  /** Команда, пришедшая от гостя. Только хост имеет право её применить. */
  enqueueRemote(command: Command): void {
    if (this.role !== "host") return;
    this.pendingCommands.push(command);
  }

  /** Подключает холст под поле соперника. В соло не вызывается. */
  attachMinimap(canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    this.minimapCanvas = canvas;
    this.minimapRenderer = new FieldRenderer(ctx);
    this.resize();
  }

  /** Поле, которое показывается в мини-карте: всегда не то, что в основном. */
  get minimapField(): number {
    return this.state.fields.length > 1 ? 1 - this.playerField : -1;
  }

  resize(): void {
    this.fitCanvas(this.canvas, (view) => (this.view = view));
    if (this.minimapCanvas) {
      this.fitCanvas(
        this.minimapCanvas,
        (view) => (this.minimapView = view),
      );
    }
  }

  private fitCanvas(
    canvas: HTMLCanvasElement,
    assign: (view: ViewTransform) => void,
  ): void {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    assign(FieldRenderer.fit(canvas.width, canvas.height));
  }

  /**
   * Сверяет размер холста с тем, сколько места он занимает на самом деле.
   *
   * Одного вызова resize() при старте мало: панели снизу меняют высоту уже
   * после первого замера — например, в версусе к ним добавляется ряд кнопок
   * отправки монстров, и поле сжимается. Холст об этом не узнавал, и дальше
   * картинка рисовалась в одном масштабе, а клики пересчитывались в другом:
   * игрок целился в площадку и промахивался мимо неё на десятки пикселей.
   */
  private syncCanvasSize(): void {
    this.syncOne(this.canvas, (view) => (this.view = view));
    if (this.minimapCanvas) {
      this.syncOne(this.minimapCanvas, (view) => (this.minimapView = view));
    }
  }

  private syncOne(
    canvas: HTMLCanvasElement,
    assign: (view: ViewTransform) => void,
  ): void {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(rect.width * dpr);
    const height = Math.round(rect.height * dpr);
    if (width === canvas.width && height === canvas.height) return;
    canvas.width = width;
    canvas.height = height;
    assign(FieldRenderer.fit(width, height));
  }

  // ── Цикл ──────────────────────────────────────────────────────────────────

  private frame(now: number): void {
    const dt = Math.min(now - this.lastFrame, 250);
    this.lastFrame = now;

    // Гость не двигает время сам — им управляет хост через снимки.
    if (!this.paused && !this.state.over && this.role !== "guest") {
      this.accumulator += dt * this.speed;
      let steps = 0;
      while (this.accumulator >= STEP_MS && steps < MAX_CATCHUP_STEPS) {
        this.tick();
        this.accumulator -= STEP_MS;
        steps++;
      }
      if (steps === MAX_CATCHUP_STEPS) this.accumulator = 0;
    }

    this.effects.update(dt / 1000);
    this.syncCanvasSize();
    this.render();
  }

  private tick(): void {
    const commands = this.pendingCommands;
    this.pendingCommands = [];

    if (this.bot) commands.push(...this.bot.update(this.state));

    const wasOver = this.state.over;
    step(this.state, commands);

    for (const field of this.state.fields) {
      if (field.owner === this.playerField) {
        this.effects.ingest(field.events);
      }
      // Звучит только своё поле: в версусе иначе получается каша из
      // выстрелов двух обороны сразу.
      this.playSounds(field.events, field.owner === this.ownField);
    }

    if (this.role === "host" && this.state.tick % SNAPSHOT_EVERY_TICKS === 0) {
      this.net?.client.sendSnapshot(encodeSnapshot(this.state));
    }

    if (!wasOver && this.state.over) {
      sound.stopMusic();
      if (this.state.winner === this.ownField) sound.victory();
      else sound.defeat();
      if (this.role === "host") {
        this.net?.client.send({
          t: "over",
          winner: this.state.winner,
          reason: this.state.endReason ?? "lives",
        });
      }
      this.callbacks.onGameOver?.(this.state);
    }

    this.callbacks.onStateChange?.(this.state);
  }

  /** Чужое поле звучит тише — иначе в версусе каша. */
  private playSounds(
    events: readonly { t: string; [k: string]: unknown }[],
    own: boolean,
  ): void {
    if (!own) return;
    for (const event of events) {
      switch (event.t) {
        case "shoot":
          sound.shoot(String(event.element));
          break;
        case "explode":
          sound.explosion();
          break;
        case "leak":
          sound.leak();
          break;
        case "wave":
          if (event.boss) sound.bossWarning();
          else sound.waveStart();
          break;
        default:
          break;
      }
    }
  }

  private render(): void {
    const ctx = this.canvas.getContext("2d")!;
    ctx.fillStyle = "#15121f";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const field = this.state.fields[this.playerField];
    if (!field) return;

    const previewRange =
      this.placement.kind === "build" && this.placement.element !== "light"
        ? towerRange(this.placement.element, 1)
        : null;

    this.renderer.draw(field, this.map, this.view, this.state.tick, {
      hoverCell: this.hoverCell,
      selectedTowerId: this.selectedTowerId,
      previewRange,
      alpha: Math.min(1, this.accumulator / STEP_MS),
    });

    ctx.save();
    FieldRenderer.applyTransform(ctx, this.view);
    this.effects.draw(ctx);
    ctx.restore();

    this.renderMinimap();
  }

  /**
   * Поле соперника. Рисуется тем же кодом, что и основное, но без подсветок
   * и эффектов: это обзор чужой обороны, а не вторая игра.
   */
  private renderMinimap(): void {
    const canvas = this.minimapCanvas;
    const renderer = this.minimapRenderer;
    if (!canvas || !renderer) return;

    const index = this.minimapField;
    const field = index >= 0 ? this.state.fields[index] : undefined;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.fillStyle = "#15121f";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!field) return;

    renderer.draw(field, this.map, this.minimapView, this.state.tick, {
      hoverCell: null,
      selectedTowerId: null,
      previewRange: null,
      alpha: Math.min(1, this.accumulator / STEP_MS),
    });
  }

  // ── Ввод ──────────────────────────────────────────────────────────────────

  /** Клетка под экранной точкой или null, если мимо поля. */
  cellAt(screenX: number, screenY: number): number | null {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const point = FieldRenderer.toField(
      this.view,
      (screenX - rect.left) * dpr,
      (screenY - rect.top) * dpr,
    );
    const col = Math.floor(point.x / CELL_SIZE);
    const row = Math.floor(point.y / CELL_SIZE);
    if (col < 0 || row < 0 || col >= GRID_COLS) return null;
    const cell = cellIndex(col, row);
    return cell;
  }

  /**
   * Тап или клик по полю. Возвращает true, если что-то произошло —
   * интерфейсу это нужно, чтобы обновиться и не проигрывать «отказ» впустую.
   */
  handleTap(screenX: number, screenY: number): boolean {
    const cell = this.cellAt(screenX, screenY);
    if (cell === null) return false;

    // Строить можно только у себя — на чужое поле смотрим, но не трогаем.
    if (this.playerField !== this.ownField) return false;

    const field = this.state.fields[this.ownField];
    if (!field) return false;

    const existing = field.occupied.get(cell);
    if (existing !== undefined) {
      // По своей башне — выбор, а не постройка: так удобнее и на мыши, и пальцем.
      this.selectedTowerId =
        this.selectedTowerId === existing ? null : existing;
      this.placement = { kind: "none" };
      return true;
    }

    if (this.placement.kind === "build" && this.map.buildSet.has(cell)) {
      const element = this.placement.element;
      const cost = ELEMENT[element].baseCost;
      if (field.gold < cost) {
        sound.denied();
        return false;
      }
      this.enqueue({ t: "build", field: this.ownField, cell, element });
      sound.build();
      return true;
    }

    this.selectedTowerId = null;
    return false;
  }

  setHover(screenX: number, screenY: number): void {
    this.hoverCell = this.cellAt(screenX, screenY);
  }

  clearHover(): void {
    this.hoverCell = null;
  }
}
