/**
 * Игровой экран: поле слева, всё управление — в боковой панели.
 *
 * Поле занимает свою область целиком и никогда не меняет размер. Раньше
 * панель выбранной башни появлялась в общем потоке, поле из-за этого
 * сжималось, и карта прыгала при каждом нажатии. Теперь всё, что появляется
 * и исчезает, живёт в отдельной колонке со своей прокруткой.
 *
 * На узком экране колонка уезжает вниз, но правило то же: поле получает
 * фиксированную долю высоты и не отдаёт её панели ни при каких условиях.
 */

import { sound } from "../audio/sound";
import {
  CREEP_KIND,
  DIFFICULTY,
  ELEMENT,
  ENDLESS_BOSS_EVERY,
  fusionCost,
  LENGTH,
  WAVE_PATTERN,
  SEND,
  TICK_RATE,
  TOWER_LEVEL_MAX,
  WAVE_INTERVAL,
  findFusion,
  healCost,
  towerCost,
  towerDamage,
  towerName,
  towerRange,
} from "../core/balance";
import { cellCol, cellRow } from "../core/map";
import { sendCost } from "../core/sim";
import type { GameSession } from "../game/session";
import type {
  CreepKind,
  ElementId,
  GameState,
  TargetMode,
  Tower,
} from "../core/types";
import { towerSprite } from "../render/sprites";
import { clear, el, formatNumber, toast } from "./dom";

const ELEMENT_ORDER: ElementId[] = [
  "fire",
  "ice",
  "lightning",
  "earth",
  "poison",
  "light",
];

const TARGET_LABELS: { mode: TargetMode; label: string; hint: string }[] = [
  { mode: "closest", label: "Ближний", hint: "Бьёт того, кто ближе к башне" },
  { mode: "first", label: "Первый", hint: "Бьёт того, кто ближе к базе" },
  { mode: "strongest", label: "Жирный", hint: "Бьёт самого живучего" },
  { mode: "fastest", label: "Быстрый", hint: "Бьёт самого быстрого" },
];

export interface GameScreenHandles {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  /** Холст поля соперника. Подключается сессией только в режимах на двоих. */
  rivalCanvas: HTMLCanvasElement;
  /** Показать или спрятать блок с полем соперника. */
  setRivalVisible: (visible: boolean) => void;
  update: (state: GameState) => void;
  destroy: () => void;
}

export function createGameScreen(
  session: () => GameSession,
  onExit: () => void,
): GameScreenHandles {
  // ── Поле ──────────────────────────────────────────────────────────────────
  const canvas = el("canvas");
  const board = el("div", { class: "board" }, [canvas]);

  // ── Показатели ────────────────────────────────────────────────────────────
  const livesEl = el("span", { text: "0" });
  const goldEl = el("span", { text: "0" });
  const waveEl = el("span", { text: "0" });
  const nextEl = el("div", { class: "hud__next" });

  const pauseBtn = el("button", {
    class: "hud__btn",
    title: "Пауза (пробел)",
    text: "❚❚",
  });
  const speedBtn = el("button", {
    class: "hud__btn",
    title: "Скорость (F)",
    text: "1×",
  });
  const soundBtn = el("button", {
    class: "hud__btn",
    title: "Звук",
    // Движок звука один на всю страницу и переживает выход в меню, поэтому
    // значок берём из него. С жёстким «🔊» во второй партии кнопка обещала
    // звук при выключенном звуке, а первое нажатие его включало.
    text: sound.enabled ? "🔊" : "🔇",
  });
  const exitBtn = el("button", {
    class: "hud__btn hud__btn--exit",
    title: "Выйти в меню",
    text: "✕",
  });

  const hud = el("div", { class: "hud" }, [
    el("div", { class: "hud__stats" }, [
      el("div", { class: "hud__stat hud__lives" }, [
        el("span", { text: "♥" }),
        livesEl,
      ]),
      el("div", { class: "hud__stat hud__gold" }, [
        el("span", { text: "◈" }),
        goldEl,
      ]),
      el("div", { class: "hud__stat hud__wave" }, [
        el("span", { text: "⚑" }),
        waveEl,
      ]),
    ]),
    el("div", { class: "hud__controls" }, [
      pauseBtn,
      speedBtn,
      soundBtn,
      exitBtn,
    ]),
    nextEl,
  ]);

  // ── Поле соперника ────────────────────────────────────────────────────────
  //
  // Всегда на виду, а не по переключению: решение отправить монстров
  // принимается ровно тогда, когда видно и свою оборону, и чужую.
  const rivalCanvas = el("canvas", {
    class: "rival__canvas",
    title: "Нажми, чтобы посмотреть это поле крупно",
  }) as HTMLCanvasElement;
  const rivalLives = el("b", { text: "—" });
  const rivalWave = el("b", { text: "—" });
  const rivalTitle = el("span", { text: "Поле соперника" });
  const rivalBlock = el("div", { class: "rival" }, [
    rivalCanvas,
    el("div", { class: "rival__stats" }, [
      rivalTitle,
      el("span", {}, ["♥ ", rivalLives]),
      el("span", {}, ["⚑ ", rivalWave]),
    ]),
  ]);
  rivalBlock.style.display = "none";

  // ── Панель выбранной башни ────────────────────────────────────────────────
  //
  // Пока башня не выбрана, здесь висит расписание ближайших волн. Место под
  // панель всё равно зарезервировано, чтобы кнопки не прыгали, — так пусть
  // оно показывает то, ради чего в игру и смотрят: что идёт дальше.
  const inspectBox = el("div", { class: "side__inspect" });

  // ── Кнопки башен ──────────────────────────────────────────────────────────
  const towerButtons = new Map<ElementId, HTMLButtonElement>();
  const towersRow = el("div", { class: "towers" });

  for (const element of ELEMENT_ORDER) {
    const cfg = ELEMENT[element];
    const preview = el("canvas", { width: 16, height: 16 });
    const previewCtx = preview.getContext("2d")!;
    previewCtx.imageSmoothingEnabled = false;
    previewCtx.drawImage(towerSprite(element, 3), 0, 0);

    const button = el(
      "button",
      {
        class: "tower-btn",
        "data-element": element,
        "aria-pressed": "false",
        title: `${cfg.label} — ${cfg.description}`,
      },
      [
        preview,
        el("span", { text: cfg.label }),
        el("span", { class: "tower-btn__cost", text: String(cfg.baseCost) }),
      ],
    ) as HTMLButtonElement;

    button.addEventListener("click", () => {
      const s = session();
      const already =
        s.placement.kind === "build" && s.placement.element === element;
      s.placement = already ? { kind: "none" } : { kind: "build", element };
      s.selectedTowerId = null;
      refreshTowerButtons();
      renderInspect();
    });

    towerButtons.set(element, button);
    towersRow.append(button);
  }

  // ── Отправка монстров сопернику ───────────────────────────────────────────
  const sendRow = el("div", { class: "sends" });
  const sendButtons = new Map<CreepKind, HTMLButtonElement>();
  const SENDABLE = Object.keys(SEND) as CreepKind[];

  for (const kind of SENDABLE) {
    const cfg = SEND[kind]!;
    const button = el(
      "button",
      {
        class: "send-btn",
        title: `${CREEP_KIND[kind].label} сопернику. Доход +${cfg.income.toFixed(1)} за волну`,
      },
      [
        el("span", { text: "↗" }),
        el("span", { text: cfg.label }),
        el("span", { class: "tower-btn__cost", text: String(cfg.cost) }),
      ],
    ) as HTMLButtonElement;

    button.addEventListener("click", () => {
      const s = session();
      const field = s.state.fields[s.ownField];
      if (!field) return;
      const cost = sendCost(field, kind);
      if (cost === null || field.gold < cost) {
        sound.denied();
        toast("Не хватает золота");
        return;
      }
      s.enqueue({ t: "send", field: s.ownField, kind });
      sound.send();
      toast(`${CREEP_KIND[kind].label} отправлены сопернику`);
    });

    sendButtons.set(kind, button);
    sendRow.append(button);
  }

  const sendBlock = el("div", { class: "side__block" }, [
    el("label", { class: "menu__label", text: "Отправить сопернику" }),
    sendRow,
  ]);
  sendBlock.style.display = "none";

  // ── Действия ──────────────────────────────────────────────────────────────
  const rushBtn = el("button", {
    class: "btn",
    text: "Волна раньше",
  }) as HTMLButtonElement;
  const healBtn = el("button", {
    class: "btn",
    text: "Купить жизнь",
  }) as HTMLButtonElement;
  const actions = el("div", { class: "actions" }, [rushBtn, healBtn]);

  const side = el("aside", { class: "side" }, [
    hud,
    rivalBlock,
    inspectBox,
    el("div", { class: "side__block" }, [towersRow]),
    sendBlock,
    actions,
  ]);

  const root = el("div", { class: "game" }, [board, side]);

  // ── Обработчики ───────────────────────────────────────────────────────────

  /**
   * Почему волну нельзя позвать прямо сейчас, или null, если можно.
   *
   * Условия те же, что в симуляции: судья — она, но кнопка и подсказка обязаны
   * говорить правду. Раньше кнопка знала только про идущую волну и не знала
   * про запрет по времени, поэтому оставалась активной и показывала тост
   * «волна вызвана досрочно», хотя команду отклоняли.
   */
  function rushBlocked(s: GameSession): string | null {
    const own = s.state.fields[s.ownField];
    if (!own) return "нет поля";
    const total = LENGTH[s.state.length].totalWaves;
    if (total !== null && own.waveIndex >= total) return "волны кончились";
    if (own.waveTimer <= 0) return "волна уже идёт";
    const left = WAVE_INTERVAL - (s.state.tick - own.lastRushTick);
    if (left > 0) return `ещё ${Math.ceil(left / TICK_RATE)} с`;
    return null;
  }

  /** Один путь и для кнопки, и для клавиши N — вместе с отказом. */
  function requestRush(): void {
    const s = session();
    const why = rushBlocked(s);
    if (why) {
      sound.denied();
      toast(`Звать волну рано: ${why}`);
      return;
    }
    s.enqueue({ t: "rush", field: s.ownField });
    toast("Волна вызвана досрочно");
  }

  rushBtn.addEventListener("click", requestRush);

  healBtn.addEventListener("click", () => {
    const s = session();
    const field = s.state.fields[s.ownField];
    if (!field) return;
    const cost = healCost(field.stats.healCount);
    if (field.gold < cost) {
      sound.denied();
      toast("Не хватает золота");
      return;
    }
    s.enqueue({ t: "heal", field: s.ownField });
    sound.heal();
    lastInspect = "";
  });

  /** Меняет местами большое поле и поле соперника. */
  function swapFields(): void {
    const s = session();
    if (s.state.fields.length < 2) return;
    s.playerField = s.playerField === s.ownField ? 1 - s.ownField : s.ownField;
    s.selectedTowerId = null;
    s.placement = { kind: "none" };
    lastInspect = "";
    updateRivalCaption();
    renderInspect();
    refreshTowerButtons();
  }

  rivalCanvas.addEventListener("click", swapFields);

  pauseBtn.addEventListener("click", () => togglePause());
  speedBtn.addEventListener("click", () => cycleSpeed());
  soundBtn.addEventListener("click", () => {
    const on = !sound.enabled;
    sound.toggleSound(on);
    sound.toggleMusic(on);
    // Значок из движка, а не из желаемого: включить звук может не получиться.
    soundBtn.textContent = sound.enabled ? "🔊" : "🔇";
  });
  exitBtn.addEventListener("click", confirmExit);

  /**
   * Выход из партии — необратимое действие: сохранений нет, а в сетевой партии
   * обрывается ещё и партия соперника. Кнопка стоит вплотную к звуку, и промах
   * пальцем на телефоне хоронил партию без единого вопроса.
   */
  function confirmExit(): void {
    const overlay = el("div", { class: "overlay" });
    const stay = el("button", {
      class: "btn btn--primary",
      text: "Остаться",
    }) as HTMLButtonElement;
    const leave = el("button", { class: "btn", text: "Выйти" });
    stay.addEventListener("click", () => overlay.remove());
    leave.addEventListener("click", () => {
      overlay.remove();
      onExit();
    });
    overlay.append(
      el("div", { class: "panel" }, [
        el("h2", { text: "Выйти в меню?" }),
        el("p", { text: "Партия не сохранится — начинать придётся заново." }),
        stay,
        leave,
      ]),
    );
    root.append(overlay);
    stay.focus();
  }

  function togglePause(): void {
    const s = session();
    s.paused = !s.paused;
    pauseBtn.setAttribute("aria-pressed", String(s.paused));
    pauseBtn.textContent = s.paused ? "▶" : "❚❚";
  }

  function cycleSpeed(): void {
    const s = session();
    s.speed = s.speed === 1 ? 2 : s.speed === 2 ? 3 : 1;
    speedBtn.textContent = `${s.speed}×`;
  }

  /*
   * Ввод по полю.
   *
   * Действие происходит по отпусканию, а не по нажатию, и только если палец
   * почти не сдвинулся. Иначе любой свайп по карте ставил башню и тратил
   * золото, а каждый лишний палец на экране считался отдельным нажатием.
   */
  const TAP_SLOP = 12;
  let activePointer: number | null = null;
  let pressX = 0;
  let pressY = 0;

  canvas.addEventListener("pointermove", (event) => {
    if (event.pointerType === "mouse")
      session().setHover(event.clientX, event.clientY);
  });
  canvas.addEventListener("pointerleave", () => session().clearHover());

  canvas.addEventListener("pointerdown", (event) => {
    // Второй и последующие пальцы игнорируем целиком.
    if (activePointer !== null) return;
    event.preventDefault();
    activePointer = event.pointerId;
    // Захватываем указатель: без этого отпускание за пределами холста
    // не приходит сюда вовсе, и поле остаётся «занятым» — следующий клик
    // по нему пропадал.
    canvas.setPointerCapture?.(event.pointerId);
    pressX = event.clientX;
    pressY = event.clientY;
    if (event.pointerType !== "mouse")
      session().setHover(event.clientX, event.clientY);
  });

  const finishPointer = (event: PointerEvent, apply: boolean): void => {
    if (event.pointerId !== activePointer) return;
    activePointer = null;
    canvas.releasePointerCapture?.(event.pointerId);
    const s = session();

    const moved =
      Math.abs(event.clientX - pressX) > TAP_SLOP ||
      Math.abs(event.clientY - pressY) > TAP_SLOP;

    if (event.pointerType !== "mouse") s.clearHover();
    if (!apply || moved) return;

    s.handleTap(event.clientX, event.clientY);
    lastInspect = "";
    refreshTowerButtons();
    renderInspect();
  };

  canvas.addEventListener("pointerup", (event) => finishPointer(event, true));
  canvas.addEventListener("pointercancel", (event) =>
    finishPointer(event, false),
  );

  const onKey = (event: KeyboardEvent): void => {
    if (event.repeat) return;
    // Поверх окна итогов или правил игровые клавиши только мешают: пробел
    // ставил партию на паузу вместо нажатия кнопки под фокусом.
    if (document.querySelector(".overlay")) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.isContentEditable)) {
      return;
    }
    const s = session();
    switch (event.key.toLowerCase()) {
      case " ":
        event.preventDefault();
        togglePause();
        break;
      case "f":
        cycleSpeed();
        break;
      case "tab":
        // Перехватываем только когда есть куда переключаться: в соло и коопе
        // поле одно, и съеденный Tab лишал панель навигации с клавиатуры.
        if (s.state.fields.length < 2) break;
        event.preventDefault();
        swapFields();
        break;
      case "escape":
        s.placement = { kind: "none" };
        s.selectedTowerId = null;
        lastInspect = "";
        refreshTowerButtons();
        renderInspect();
        break;
      case "n":
        requestRush();
        break;
      default: {
        // Цифры 1–6 — быстрый выбор башни, привычно по варкрафту.
        const index = Number(event.key) - 1;
        const element = ELEMENT_ORDER[index];
        if (element) {
          s.placement = { kind: "build", element };
          s.selectedTowerId = null;
          refreshTowerButtons();
          renderInspect();
        }
      }
    }
  };
  window.addEventListener("keydown", onKey);

  const onResize = (): void => session().resize();
  window.addEventListener("resize", onResize);
  window.addEventListener("orientationchange", onResize);

  // ── Отрисовка панелей ─────────────────────────────────────────────────────

  function refreshTowerButtons(): void {
    const s = session();
    const field = s.state.fields[s.ownField];
    if (!field) return;
    const watching = s.playerField !== s.ownField;

    for (const [element, button] of towerButtons) {
      const chosen =
        s.placement.kind === "build" && s.placement.element === element;
      button.setAttribute("aria-pressed", String(chosen));
      // На чужом поле строить нельзя — гасим панель, чтобы это было видно.
      button.disabled = watching || field.gold < ELEMENT[element].baseCost;
    }

    for (const [kind, button] of sendButtons) {
      const cost = sendCost(field, kind);
      button.disabled = cost === null || field.gold < cost;
      const label = button.querySelector(".tower-btn__cost");
      if (label && cost !== null) label.textContent = String(cost);
    }
  }

  function updateRivalCaption(): void {
    const s = session();
    rivalTitle.textContent =
      s.playerField === s.ownField ? "Поле соперника" : "Твоё поле";
  }

  function renderInspect(): void {
    const s = session();
    const field = s.state.fields[s.playerField];
    clear(inspectBox);
    damageEl = null;
    if (!field) return;

    const tower =
      s.selectedTowerId === null
        ? undefined
        : field.towers.find((t) => t.id === s.selectedTowerId);

    if (s.selectedTowerId !== null && !tower) {
      // Башню продали или она принадлежит другому полю.
      s.selectedTowerId = null;
    }

    inspectBox.append(tower ? buildInspectPanel(s, tower) : buildSchedule(s));
  }

  /**
   * Расписание ближайших волн.
   *
   * Тип волны надо знать заранее: против летающих нужны башни, достающие до
   * воздуха, против роя — урон по площади, и строить это в момент, когда волна
   * уже вышла, поздно.
   */
  function buildSchedule(s: GameSession): HTMLElement {
    const field = s.state.fields[s.playerField];
    const panel = el("div", { class: "schedule" }, [
      el("div", { class: "menu__label", text: "Ближайшие волны" }),
    ]);
    if (!field) return panel;

    const lengthCfg = LENGTH[s.state.length];
    for (let offset = 0; offset < 6; offset++) {
      const index = field.waveIndex + offset;
      const number = index + 1;
      if (lengthCfg.totalWaves !== null && number > lengthCfg.totalWaves) break;

      const boss =
        lengthCfg.totalWaves === null
          ? number % ENDLESS_BOSS_EVERY === 0
          : lengthCfg.bossWaves.includes(number);
      const kind: CreepKind = boss
        ? "boss"
        : (WAVE_PATTERN[index % WAVE_PATTERN.length] ?? "normal");

      const row = el("div", { class: "schedule__row" }, [
        el("span", { class: "schedule__num", text: `${number}` }),
        el("span", { class: "schedule__kind", text: CREEP_KIND[kind].label }),
        el("span", { class: "schedule__hint", text: waveHint(kind) }),
      ]);
      if (offset === 0) row.classList.add("schedule__row--next");
      if (boss) row.classList.add("schedule__row--boss");
      panel.append(row);
    }

    return panel;
  }

  /** Чем волна опасна — одной строкой, без чтения справки. */
  function waveHint(kind: CreepKind): string {
    switch (kind) {
      case "fast":
        return "нужен лёд";
      case "flying":
        return "земля не достаёт";
      case "swarm":
        return "нужен урон по площади";
      case "armored":
        return "держат удар";
      case "boss":
        return "яд и много урона";
      default:
        return "";
    }
  }

  function buildInspectPanel(s: GameSession, tower: Tower): HTMLElement {
    const cfg = ELEMENT[tower.element];
    const shownField = s.state.fields[s.playerField]!;
    const ownField = s.state.fields[s.ownField]!;
    const aura = shownField.auraCache.get(tower.id);
    const maxed = tower.level >= TOWER_LEVEL_MAX;
    const nextCost = maxed ? 0 : towerCost(tower.element, tower.level + 1);
    const refund = Math.floor(
      tower.invested * DIFFICULTY[s.state.difficulty].sellRefund,
    );

    const panel = el("div", { class: "inspect" }, [
      el("div", { class: "inspect__head" }, [
        el("span", {
          text: `${towerName(tower.element, tower.fused)} · уровень ${tower.level}`,
        }),
      ]),
      el("div", { class: "inspect__desc", text: cfg.description }),
    ]);

    // Ссылку на счётчик урона храним отдельно: в слепке панели его нет (иначе
    // панель пересобиралась бы на каждый выстрел), поэтому число обновляется
    // поштучно в update(). Без этого оно стояло намертво.
    damageEl = el("b", { text: formatNumber(tower.damageDealt) });

    const stats = el("div", { class: "inspect__stats" }, [
      el("span", {}, [
        "Урон ",
        el("b", {
          text: formatNumber(towerDamage(tower.element, tower.level)),
        }),
      ]),
      el("span", {}, [
        "Дальность ",
        el("b", {
          text: formatNumber(
            towerRange(tower.element, tower.level) * (aura?.rangeMult ?? 1),
          ),
        }),
      ]),
      el("span", {}, ["Нанесено ", damageEl]),
    ]);
    if (aura && aura.damageMult > 1) {
      stats.append(
        el("span", {}, [
          "От аур ",
          el("b", { text: `+${Math.round((aura.damageMult - 1) * 100)}%` }),
        ]),
      );
    }
    panel.append(stats);

    // На чужом поле башню видно, но трогать её нельзя.
    if (s.playerField !== s.ownField) {
      panel.append(
        el("div", { class: "inspect__desc", text: "Башня соперника" }),
      );
      return panel;
    }

    if (tower.element !== "light") {
      const targeting = el("div", { class: "targeting" });
      for (const option of TARGET_LABELS) {
        const button = el("button", {
          text: option.label,
          title: option.hint,
          "aria-pressed": String(tower.targetMode === option.mode),
        });
        button.addEventListener("click", () => {
          s.enqueue({
            t: "target",
            field: s.ownField,
            tower: tower.id,
            mode: option.mode,
          });
          // Команда применится на следующем тике, а кнопку переключаем сразу.
          tower.targetMode = option.mode;
          lastInspect = "";
          renderInspect();
        });
        targeting.append(button);
      }
      panel.append(targeting);
    }

    const fusions = availableFusions(s, tower);
    if (fusions.length > 0) {
      panel.append(
        el("div", {
          class: "inspect__desc",
          text: "Слить с соседней: эффекты обеих стихий на одной цели, площадка освободится",
        }),
      );
      const row = el("div", { class: "inspect__row" });
      for (const option of fusions) {
        const button = el("button", {
          class: "btn",
          text: `${option.recipe.label} · ${option.cost}`,
          title: option.recipe.description,
        }) as HTMLButtonElement;
        button.disabled = ownField.gold < option.cost;
        button.addEventListener("click", () => {
          s.enqueue({
            t: "fuse",
            field: s.ownField,
            tower: tower.id,
            with: option.neighbour.id,
          });
          sound.upgrade();
          toast(`${option.recipe.label} собран`);
          s.selectedTowerId = null;
          lastInspect = "";
          renderInspect();
        });
        row.append(button);
      }
      panel.append(row);
    }

    const upgradeBtn = el("button", {
      class: "btn btn--primary",
      text: maxed ? "Максимум" : `Улучшить · ${nextCost}`,
    }) as HTMLButtonElement;
    upgradeBtn.disabled = maxed || ownField.gold < nextCost;
    upgradeBtn.addEventListener("click", () => {
      if (maxed || ownField.gold < nextCost) {
        sound.denied();
        toast("Не хватает золота");
        return;
      }
      s.enqueue({ t: "upgrade", field: s.ownField, tower: tower.id });
      sound.upgrade();
      // Команда применится на следующем шаге симуляции — гасим кнопку сразу,
      // иначе можно успеть нажать её несколько раз подряд.
      upgradeBtn.disabled = true;
      lastInspect = "";
    });

    const sellBtn = el("button", {
      class: "btn btn--danger",
      text: `Продать · ${refund}`,
    }) as HTMLButtonElement;
    sellBtn.addEventListener("click", () => {
      s.enqueue({ t: "sell", field: s.ownField, tower: tower.id });
      s.selectedTowerId = null;
      sound.sell();
      lastInspect = "";
      renderInspect();
    });

    panel.append(el("div", { class: "inspect__row" }, [upgradeBtn, sellBtn]));
    return panel;
  }

  /**
   * Соседи, с которыми выбранную башню можно слить.
   * Показываем только доступные пары — заставлять игрока помнить таблицу
   * из восьми рецептов незачем.
   */
  function availableFusions(
    s: GameSession,
    tower: Tower,
  ): {
    neighbour: Tower;
    recipe: NonNullable<ReturnType<typeof findFusion>>;
    cost: number;
  }[] {
    if (tower.fused) return [];
    const field = s.state.fields[s.ownField];
    if (!field) return [];

    const col = cellCol(tower.cell);
    const row = cellRow(tower.cell);
    const result = [];

    for (const other of field.towers) {
      if (other.id === tower.id || other.fused) continue;
      if (Math.abs(cellCol(other.cell) - col) > 1) continue;
      if (Math.abs(cellRow(other.cell) - row) > 1) continue;
      const recipe = findFusion(tower.element, other.element);
      if (!recipe) continue;
      result.push({
        neighbour: other,
        recipe,
        cost: fusionCost(tower, other),
      });
    }
    return result;
  }

  /**
   * Слепок того, что показывает панель выбранной башни.
   *
   * Панель перерисовывается не на каждое изменение золота (иначе она мигала бы
   * весь бой), а когда меняется что-то из показанного. Это важно потому, что
   * команда игрока применяется на следующем шаге симуляции — без такой сверки
   * нажатие «Улучшить» выглядело так, будто ничего не произошло.
   */
  function inspectSignature(s: GameSession): string {
    if (s.selectedTowerId === null) {
      // Ничего не выбрано — показывается расписание. Оно строится по тому же
      // полю, которое сейчас на экране, поэтому и слепок берём оттуда же:
      // иначе при просмотре чужого поля список переставал обновляться.
      const shownField = s.state.fields[s.playerField];
      return `расписание:${shownField?.waveIndex ?? -1}:${s.playerField}`;
    }
    const field = s.state.fields[s.playerField];
    const own = s.state.fields[s.ownField];
    const tower = field?.towers.find((t) => t.id === s.selectedTowerId);
    if (!field || !own || !tower) return "нет";

    const nextCost =
      tower.level >= TOWER_LEVEL_MAX
        ? 0
        : towerCost(tower.element, tower.level + 1);
    // Ауры входят в слепок: панель показывает дальность с их множителем, а
    // появиться сосед-свет может и без всякого участия выбранной башни.
    const aura = field.auraCache.get(tower.id);
    return [
      tower.id,
      tower.level,
      tower.fused ?? "-",
      tower.targetMode,
      own.gold >= nextCost ? 1 : 0,
      s.playerField,
      availableFusions(s, tower).length,
      aura ? `${aura.damageMult}x${aura.rangeMult}` : "-",
    ].join(":");
  }

  let lastGold = -1;
  let lastHint = "";
  let lastInspect = "";
  /** Узел со счётчиком нанесённого урона в открытой панели башни. */
  let damageEl: HTMLElement | null = null;
  let versusReady = false;
  let controlsChecked = false;

  function update(state: GameState): void {
    const s = session();
    const shown = state.fields[s.playerField];
    const own = state.fields[s.ownField];
    if (!shown || !own) return;

    // Показатели всегда свои: чужие видно на карте соперника отдельно.
    livesEl.textContent = String(own.lives);
    goldEl.textContent = formatNumber(own.gold);

    const total = LENGTH[state.length].totalWaves;
    waveEl.textContent =
      total === null ? `${own.waveIndex}` : `${own.waveIndex} / ${total}`;

    const wavesLeft = total === null || own.waveIndex < total;
    const seconds = Math.ceil(own.waveTimer / TICK_RATE);
    const blocked = rushBlocked(s);
    // Подсказка обещает клавишу N только когда призыв действительно возможен.
    const hint = `${seconds}:${blocked ?? ""}:${s.hostPaused ? "п" : ""}`;
    if (hint !== lastHint) {
      lastHint = hint;
      nextEl.innerHTML = s.hostPaused
        ? "хост поставил паузу"
        : !wavesLeft
          ? "волны кончились — добей оставшихся"
          : own.waveTimer <= 0
            ? "волна идёт"
            : blocked
              ? `следующая волна через <b>${seconds}</b> с`
              : `следующая волна через <b>${seconds}</b> с · <b>N</b> — вызвать сейчас`;
    }

    const cost = healCost(own.stats.healCount);
    healBtn.textContent = `Жизнь · ${formatNumber(cost)}`;
    healBtn.disabled = own.gold < cost;

    // Кнопка гаснет по тем же условиям, по которым симуляция откажет: и когда
    // волны кончились, и пока не вышел запрет по времени после призыва.
    rushBtn.disabled = blocked !== null;
    rushBtn.title = blocked ? `Звать волну рано: ${blocked}` : "Волна раньше";

    // Блоки для игры вдвоём появляются один раз, когда становится ясно,
    // что полей действительно два.
    if (!controlsChecked) {
      controlsChecked = true;
      if (s.role === "guest") {
        // Партию считает хост: местная пауза и ускорение ни на что не влияют.
        pauseBtn.style.display = "none";
        speedBtn.style.display = "none";
      }
    }

    if (!versusReady && state.fields.length > 1) {
      versusReady = true;
      rivalBlock.style.display = "";
      if (state.mode === "versus") sendBlock.style.display = "";
      updateRivalCaption();
      session().resize();
    }

    if (versusReady) {
      const rival = state.fields[s.minimapField];
      rivalLives.textContent = rival ? String(rival.lives) : "—";
      rivalWave.textContent = rival ? String(rival.waveIndex) : "—";
    }

    if (own.gold !== lastGold) {
      lastGold = own.gold;
      refreshTowerButtons();
    }

    const signature = inspectSignature(s);
    if (signature !== lastInspect) {
      lastInspect = signature;
      renderInspect();
    }

    // Счётчика нанесённого урона в слепке нет, поэтому обновляем сам узел:
    // иначе он показывал число на момент открытия панели и стоял, пока
    // игрок не тронет что-нибудь ещё.
    if (damageEl) {
      const tower = shown.towers.find((t) => t.id === s.selectedTowerId);
      const text = formatNumber(tower?.damageDealt ?? 0);
      if (damageEl.textContent !== text) damageEl.textContent = text;
    }
  }

  function destroy(): void {
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", onResize);
    window.removeEventListener("orientationchange", onResize);
  }

  return {
    root,
    canvas,
    rivalCanvas,
    setRivalVisible: (visible: boolean) => {
      rivalBlock.style.display = visible ? "" : "none";
    },
    update,
    destroy,
  };
}
