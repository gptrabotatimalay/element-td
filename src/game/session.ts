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
  GRID_ROWS,
  cellIndex,
  getMap,
  type GameMap,
} from "../core/map";
import { createGame, step, type GameOptions } from "../core/sim";
import type { Command, ElementId, GameState } from "../core/types";
import type { RoomClient } from "../net/client";
import { encodeSnapshot, decodeField } from "../net/snapshot";
import { ELEMENTS, type Snapshot } from "../net/protocol";
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

/** Как часто перерисовывается поле соперника, в миллисекундах. */
const MINIMAP_INTERVAL_MS = 100;

/**
 * Плотность пикселей холста.
 *
 * Ограничение двойкой оставляло экраны с плотностью 3 без целого числа
 * экранных пикселей на игровой — пиксель-арт на них мылился по краям.
 * Целое значение сохраняет резкость и не раздувает холст сверх нужного.
 */
function canvasScale(): number {
  // Округление вниз ухудшало картинку там, где плотность дробная: на экране
  // с 2.625 холст рисовался как при 2 и растягивался браузером с мылом.
  // Берём фактическое значение, ограничив разумным потолком.
  return Math.max(1, Math.min(3, window.devicePixelRatio || 1));
}

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
  private readonly ctx: CanvasRenderingContext2D;
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
  private minimapCtx: CanvasRenderingContext2D | null = null;
  private minimapView: ViewTransform = {
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    rotated: false,
  };
  /**
   * Поле соперника обновляется реже основного.
   *
   * Оно вчетверо меньше и служит для обзора, а не для точных действий —
   * рисовать его шестьдесят раз в секунду значит удваивать всю отрисовку
   * ради картинки, на которой разница между кадрами не видна.
   */
  private minimapDrawnAt = 0;

  private accumulator = 0;
  private lastFrame = 0;
  private rafId: number | null = null;

  private bot: AutoPlayer | null = null;
  private pendingCommands: Command[] = [];

  private net: NetworkSetup | null = null;
  role: SessionRole = "local";
  /** Последний снимок от хоста — гость рисует именно его. */
  private lastSnapshotTick = -1;
  private lastSnapshotAt = 0;
  private prevLives = -1;
  private prevWave = -1;
  private prevProjectiles = 0;

  /**
   * Поле, которым управляет этот клиент. Команды всегда уходят сюда.
   * Отделено от просматриваемого: в версусе можно смотреть на соперника,
   * продолжая строить у себя.
   */
  ownField = 0;

  /** Поле, которое сейчас нарисовано на экране. */
  get playerField(): number {
    return this.viewField;
  }

  set playerField(index: number) {
    if (this.viewField === index) return;
    this.viewField = index;
    // Вспышки и следы молний относятся к прежнему полю: если их не убрать,
    // они дорисовываются поверх чужой карты.
    this.effects.clear();
  }

  private viewField = 0;
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
    this.ctx = ctx;
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
    this.state.fields = snapshot.fields.map((field, index) =>
      decodeField(field, index),
    );
    // Гость не считает партию, поэтому накопитель у него всегда нулевой, а
    // вместе с ним и сглаживание. Двигаем его вручную, чтобы монстры между
    // снимками ехали плавно, а не прыгали десять раз в секунду.
    this.accumulator = 0;
    this.lastSnapshotAt = performance.now();

    // Гость не считает партию, поэтому журнала событий у него нет: без этого
    // он не слышал ни выстрелов, ни утечки жизни и не видел ни одной вспышки.
    // Восстанавливаем главное по разнице между снимками.
    this.replayGuestEvents(snapshot);

    const wasOver = this.state.over;
    this.state.over = snapshot.over;
    this.state.winner = snapshot.winner;

    if (!wasOver && snapshot.over) {
      sound.stopMusic();
      // Победу определяет своё поле, а не то, на которое сейчас смотрим.
      if (snapshot.winner === this.ownField) sound.victory();
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

  /**
   * Команда, пришедшая от гостя.
   *
   * Хост обязан проверить, к какому полю она относится: иначе второй игрок
   * может строить, продавать и качать башни прямо на поле хоста, а в версусе
   * ещё и слать монстров самому себе. Поле определяется отправителем, а не
   * содержимым команды.
   */
  enqueueRemote(command: Command, fromField: number): void {
    if (this.role !== "host") return;
    if (command.field !== fromField) return;
    this.pendingCommands.push(command);
  }

  /** Подключает холст под поле соперника. В соло не вызывается. */
  attachMinimap(canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    this.minimapCanvas = canvas;
    this.minimapCtx = ctx;
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
    const dpr = canvasScale();
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
    const dpr = canvasScale();
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

    // У гостя время между снимками играет роль накопителя: снимки приходят
    // раз в три тика, и без этого движение выглядело бы рывками.
    if (this.role === "guest" && this.lastSnapshotAt > 0) {
      this.accumulator = Math.min(
        STEP_MS * SNAPSHOT_EVERY_TICKS,
        now - this.lastSnapshotAt,
      );
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
      void field;
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
        // Сначала последнее состояние, потом сообщение о конце: иначе гость
        // остаётся с предпоследним снимком и не видит, чем всё кончилось.
        this.net?.client.sendSnapshot(encodeSnapshot(this.state));
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
    const ctx = this.ctx;
    ctx.fillStyle = "#15121f";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const field = this.state.fields[this.playerField];
    if (!field) return;

    // На чужом поле строить нельзя, поэтому ни рамки на площадке, ни круга
    // радиуса там быть не должно: они обещают действие, которого не будет.
    const own = this.playerField === this.ownField;
    const previewRange =
      own && this.placement.kind === "build" && this.placement.element !== "light"
        ? towerRange(this.placement.element, 1)
        : null;

    this.renderer.draw(field, this.map, this.view, this.state.tick, {
      hoverCell: own ? this.hoverCell : null,
      selectedTowerId: this.selectedTowerId,
      previewRange,
      alpha: this.smoothing(),
    });

    ctx.save();
    FieldRenderer.applyTransform(ctx, this.view);
    this.effects.rotated = this.view.rotated;
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

    const now = this.lastFrame;
    if (now - this.minimapDrawnAt < MINIMAP_INTERVAL_MS) return;
    this.minimapDrawnAt = now;

    const index = this.minimapField;
    const field = index >= 0 ? this.state.fields[index] : undefined;
    const ctx = this.minimapCtx;
    if (!ctx) return;

    ctx.fillStyle = "#15121f";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!field) return;

    renderer.draw(field, this.map, this.minimapView, this.state.tick, {
      hoverCell: null,
      selectedTowerId: null,
      previewRange: null,
      // Между кадрами мини-карты проходит несколько тиков, поэтому доля
      // основного поля здесь не годится: с ней монстры дёргались.
      alpha: 1,
    });
  }

  /**
   * Восстанавливает события по разнице снимков.
   *
   * Точную картину так не получить, но важное — потерю жизни, приход волны и
   * то, что башни стреляют, — видно и слышно. Без этого сетевая партия у
   * гостя проходила в полной тишине и без единого эффекта.
   */
  private replayGuestEvents(snapshot: Snapshot): void {
    const mine = snapshot.fields[this.ownField];
    if (!mine) return;

    if (this.prevLives >= 0 && mine.lives < this.prevLives) sound.leak();
    if (this.prevWave >= 0 && mine.wave > this.prevWave) {
      sound.waveStart();
    }
    this.prevLives = mine.lives;
    this.prevWave = mine.wave;

    // Летящие снаряды означают, что башни работают.
    const shown = snapshot.fields[this.playerField];
    if (shown && shown.projectiles.length > this.prevProjectiles) {
      const first = shown.projectiles[0];
      if (first) sound.shoot(ELEMENTS[first[2]] ?? "fire");
    }
    this.prevProjectiles = shown?.projectiles.length ?? 0;
  }

  /** Доля пути между последними двумя состояниями, 0..1. */
  private smoothing(): number {
    const span =
      this.role === "guest" ? STEP_MS * SNAPSHOT_EVERY_TICKS : STEP_MS;
    return Math.min(1, this.accumulator / span);
  }

  // ── Ввод ──────────────────────────────────────────────────────────────────

  /** Клетка под экранной точкой или null, если мимо поля. */
  cellAt(screenX: number, screenY: number): number | null {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = canvasScale();
    const point = FieldRenderer.toField(
      this.view,
      (screenX - rect.left) * dpr,
      (screenY - rect.top) * dpr,
    );
    const col = Math.floor(point.x / CELL_SIZE);
    const row = Math.floor(point.y / CELL_SIZE);
    if (col < 0 || row < 0 || col >= GRID_COLS || row >= GRID_ROWS) return null;
    return cellIndex(col, row);
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
