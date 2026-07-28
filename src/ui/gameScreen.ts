/**
 * Игровой экран: панель сверху, поле в середине, управление снизу.
 *
 * Порядок не случаен. На телефоне палец закрывает низ экрана, поэтому вся
 * важная информация (жизни, золото, номер волны) вынесена наверх, а всё, что
 * нажимают, — вниз, в зону большого пальца.
 */

import { sound } from "../audio/sound";
import {
  CREEP_KIND,
  DIFFICULTY,
  ELEMENT,
  LENGTH,
  SEND,
  TICK_RATE,
  TOWER_LEVEL_MAX,
  FUSION_COST_SHARE,
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
  update: (state: GameState) => void;
  destroy: () => void;
}

export function createGameScreen(
  session: () => GameSession,
  onExit: () => void,
): GameScreenHandles {
  const canvas = el("canvas");
  const fieldBox = el("div", { class: "field" }, [canvas]);

  // ── Панель сверху ─────────────────────────────────────────────────────────
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
    text: "🔊",
  });
  const exitBtn = el("button", {
    class: "hud__btn",
    title: "Выйти в меню",
    text: "✕",
  });

  const hud = el("div", { class: "hud" }, [
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
    el("div", { class: "hud__spacer" }),
    pauseBtn,
    speedBtn,
    soundBtn,
    exitBtn,
    nextEl,
  ]);

  // ── Панель выбора башен ───────────────────────────────────────────────────
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

  // ── Действия ──────────────────────────────────────────────────────────────
  const rushBtn = el("button", {
    class: "btn",
    text: "Волна раньше",
  }) as HTMLButtonElement;
  const healBtn = el("button", {
    class: "btn",
    text: "Купить жизнь",
  }) as HTMLButtonElement;
  const viewBtn = el("button", {
    class: "btn",
    text: "Поле соперника",
  }) as HTMLButtonElement;
  const actions = el("div", { class: "actions" }, [rushBtn, healBtn]);

  /**
   * Отправка монстров сопернику — сердце версуса.
   *
   * Каждая отправка стоит золота сейчас и навсегда повышает свой доход,
   * поэтому ранняя агрессия окупается, но оголяет собственную оборону.
   * Панель показывается только в версусе: в соло и коопе слать некому.
   */
  const sendRow = el("div", { class: "towers" });
  const sendButtons = new Map<CreepKind, HTMLButtonElement>();
  const SENDABLE = Object.keys(SEND) as CreepKind[];

  for (const kind of SENDABLE) {
    const cfg = SEND[kind]!;
    const button = el(
      "button",
      {
        class: "tower-btn",
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

  /** В версусе можно подсмотреть, как дела у соперника. */
  let watchingOpponent = false;
  viewBtn.addEventListener("click", () => {
    const s = session();
    if (s.state.fields.length < 2) return;
    watchingOpponent = !watchingOpponent;
    s.playerField = watchingOpponent ? 1 - s.ownField : s.ownField;
    s.selectedTowerId = null;
    s.placement = { kind: "none" };
    viewBtn.textContent = watchingOpponent ? "Своё поле" : "Поле соперника";
    viewBtn.setAttribute("aria-pressed", String(watchingOpponent));
    renderInspect();
    refreshTowerButtons();
  });

  const inspectBox = el("div");
  const sendBox = el("div");
  const dock = el("div", { class: "dock" }, [
    inspectBox,
    sendBox,
    towersRow,
    actions,
  ]);
  const rotateHint = el("div", {
    class: "rotate-hint",
    text: "Поверни телефон — поле станет вдвое крупнее",
  });
  const root = el("div", { class: "game" }, [hud, fieldBox, rotateHint, dock]);

  // ── Обработчики ───────────────────────────────────────────────────────────

  rushBtn.addEventListener("click", () => {
    const s = session();
    s.enqueue({ t: "rush", field: s.ownField });
    toast("Волна вызвана досрочно");
  });

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
  });

  pauseBtn.addEventListener("click", () => togglePause());
  speedBtn.addEventListener("click", () => cycleSpeed());
  soundBtn.addEventListener("click", () => {
    const on = !sound.enabled;
    sound.toggleSound(on);
    sound.toggleMusic(on);
    soundBtn.textContent = on ? "🔊" : "🔇";
  });
  exitBtn.addEventListener("click", onExit);

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

  // Поле: клик мышью и касание пальцем.
  canvas.addEventListener("pointermove", (event) => {
    if (event.pointerType === "mouse")
      session().setHover(event.clientX, event.clientY);
  });
  canvas.addEventListener("pointerleave", () => session().clearHover());
  canvas.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const s = session();
    // Палец не наводит курсор — подсветку выставляем прямо в момент касания.
    if (event.pointerType !== "mouse") s.setHover(event.clientX, event.clientY);
    s.handleTap(event.clientX, event.clientY);
    refreshTowerButtons();
    renderInspect();
  });

  const onKey = (event: KeyboardEvent): void => {
    if (event.repeat) return;
    const s = session();
    switch (event.key.toLowerCase()) {
      case " ":
        event.preventDefault();
        togglePause();
        break;
      case "f":
        cycleSpeed();
        break;
      case "escape":
        s.placement = { kind: "none" };
        s.selectedTowerId = null;
        refreshTowerButtons();
        renderInspect();
        break;
      case "n":
        s.enqueue({ t: "rush", field: s.ownField });
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

  // ── Отрисовка интерфейса ──────────────────────────────────────────────────

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

  function renderInspect(): void {
    const s = session();
    const field = s.state.fields[s.playerField];
    clear(inspectBox);
    if (!field || s.selectedTowerId === null) return;

    const tower = field.towers.find((t) => t.id === s.selectedTowerId);
    if (!tower) {
      s.selectedTowerId = null;
      return;
    }

    inspectBox.append(buildInspectPanel(s, tower));
  }

  function buildInspectPanel(s: GameSession, tower: Tower): HTMLElement {
    const cfg = ELEMENT[tower.element];
    const field = s.state.fields[s.playerField]!;
    const aura = field.auraCache.get(tower.id);
    const maxed = tower.level >= TOWER_LEVEL_MAX;
    const nextCost = maxed ? 0 : towerCost(tower.element, tower.level + 1);
    const refund = Math.floor(
      tower.invested * DIFFICULTY[s.state.difficulty].sellRefund,
    );

    const head = el("div", { class: "inspect__head" }, [
      el("span", {
        text: `${towerName(tower.element, tower.fused)} · уровень ${tower.level}`,
      }),
    ]);

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
      el("span", {}, [
        "Нанесено ",
        el("b", { text: formatNumber(tower.damageDealt) }),
      ]),
    ]);

    // Показываем усиление аурой только когда оно есть — иначе шум.
    if (aura && aura.damageMult > 1) {
      stats.append(
        el("span", {}, [
          "От аур ",
          el("b", { text: `+${Math.round((aura.damageMult - 1) * 100)}%` }),
        ]),
      );
    }

    const upgradeBtn = el("button", {
      class: "btn btn--primary",
      text: maxed ? "Максимум" : `Улучшить · ${nextCost}`,
    }) as HTMLButtonElement;
    upgradeBtn.disabled = maxed || field.gold < nextCost;
    upgradeBtn.addEventListener("click", () => {
      s.enqueue({ t: "upgrade", field: s.ownField, tower: tower.id });
      sound.upgrade();
    });

    const sellBtn = el("button", {
      class: "btn btn--danger",
      text: `Продать · ${refund}`,
    }) as HTMLButtonElement;
    sellBtn.addEventListener("click", () => {
      s.enqueue({ t: "sell", field: s.ownField, tower: tower.id });
      s.selectedTowerId = null;
      sound.sell();
      renderInspect();
    });

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
        renderInspect();
      });
      targeting.append(button);
    }

    const panel = el("div", { class: "inspect" }, [
      head,
      el("div", { class: "inspect__desc", text: cfg.description }),
      stats,
    ]);

    // На чужом поле башню видно, но трогать её нельзя — незачем показывать
    // кнопки, которые всё равно отклонит симуляция.
    if (s.playerField !== s.ownField) {
      panel.append(
        el("div", { class: "inspect__desc", text: "Башня соперника" }),
      );
      return panel;
    }

    if (tower.element !== "light") panel.append(targeting);

    const fusions = availableFusions(s, tower);
    if (fusions.length > 0) {
      panel.append(
        el("div", {
          class: "inspect__desc",
          text: "Слить с соседней башней — эффекты обеих стихий на одной цели, освободится площадка:",
        }),
      );
      const row = el("div", { class: "inspect__row" });
      for (const option of fusions) {
        const button = el("button", {
          class: "btn",
          text: `${option.recipe.label} · ${option.cost}`,
          title: option.recipe.description,
        }) as HTMLButtonElement;
        button.disabled = field.gold < option.cost;
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
          renderInspect();
        });
        row.append(button);
      }
      panel.append(row);
    }

    panel.append(el("div", { class: "inspect__row" }, [upgradeBtn, sellBtn]));
    return panel;
  }

  let lastWave = -1;
  let lastGold = -1;

  /**
   * Соседи, с которыми выбранную башню можно слить.
   * Показываем только реально доступные пары — заставлять игрока помнить
   * таблицу из восьми рецептов незачем.
   */
  function availableFusions(
    s: GameSession,
    tower: Tower,
  ): { neighbour: Tower; recipe: ReturnType<typeof findFusion> & object; cost: number }[] {
    if (tower.fused) return [];
    const field = s.state.fields[s.ownField];
    if (!field) return [];

    const col = cellCol(tower.cell);
    const row = cellRow(tower.cell);
    const result = [];

    for (const other of field.towers) {
      if (other.id === tower.id || other.fused) continue;
      const dc = Math.abs(cellCol(other.cell) - col);
      const dr = Math.abs(cellRow(other.cell) - row);
      if (dc > 1 || dr > 1) continue;
      const recipe = findFusion(tower.element, other.element);
      if (!recipe) continue;
      result.push({
        neighbour: other,
        recipe,
        cost: Math.round(other.invested * FUSION_COST_SHARE),
      });
    }
    return result;
  }

  let versusReady = false;

  function update(state: GameState): void {
    const s = session();
    const field = state.fields[s.playerField];
    if (!field) return;

    // Панель отправки и переключение поля нужны только в версусе.
    if (!versusReady && state.mode === "versus" && state.fields.length > 1) {
      versusReady = true;
      sendBox.append(
        el("label", { class: "menu__label", text: "Отправить сопернику" }),
        sendRow,
      );
      actions.append(viewBtn);
    }

    livesEl.textContent = String(field.lives);
    goldEl.textContent = formatNumber(field.gold);

    const total = LENGTH[state.length].totalWaves;
    waveEl.textContent =
      total === null ? `${field.waveIndex}` : `${field.waveIndex} / ${total}`;

    const seconds = Math.ceil(field.waveTimer / TICK_RATE);
    if (watchingOpponent) {
      // Смотрим на чужое поле — цифры сверху тоже чужие, это надо сказать.
      nextEl.innerHTML = "<b>смотрим поле соперника</b> — строить нельзя";
    } else {
      nextEl.innerHTML =
        field.waveTimer > 0
          ? `следующая волна через <b>${seconds}</b> с · <b>N</b> — вызвать сейчас`
          : "волна идёт";
    }

    const cost = healCost(field.stats.healCount);
    healBtn.textContent = `Купить жизнь · ${formatNumber(cost)}`;
    healBtn.disabled = field.gold < cost;
    rushBtn.disabled = field.waveTimer <= 0;

    // Перерисовываем панели только когда есть повод — иначе теряется
    // фокус на кнопках и мигает выделение.
    if (field.gold !== lastGold) {
      lastGold = field.gold;
      refreshTowerButtons();
    }
    if (field.waveIndex !== lastWave) {
      lastWave = field.waveIndex;
      renderInspect();
    }
  }

  function destroy(): void {
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", onResize);
    window.removeEventListener("orientationchange", onResize);
  }

  return { root, canvas, update, destroy };
}
