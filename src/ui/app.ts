/**
 * Экраны и переходы между ними: меню → партия → итог.
 *
 * Меню помнит последний выбор, потому что по вечерам подряд играют одним и тем
 * же составом настроек, и заново тыкать четыре списка каждый раз — раздражает.
 */

import { sound } from "../audio/sound";
import { MAPS } from "../core/map";
import { GameSession } from "../game/session";
import type { RoomClient } from "../net/client";
import type {
  Difficulty,
  GameMode,
  GameState,
  MatchLength,
} from "../core/types";
import { clear, el, formatNumber } from "./dom";
import { createGameScreen, type GameScreenHandles } from "./gameScreen";
import { createLobbyScreen, type LobbyResult } from "./lobbyScreen";
import {
  hasSeenHelp,
  loadRecords,
  loadSettings,
  markHelpSeen,
  saveRecord,
  saveSettings,
} from "./storage";

/**
 * Сколько ждём возвращения соперника, прежде чем закончить партию.
 * На телефоне связь проседает регулярно, и мгновенное завершение по первому
 * же разрыву делало сетевую игру невозможной.
 */
const RECONNECT_GRACE_MS = 12_000;

interface MatchSetup {
  mode: GameMode;
  difficulty: Difficulty;
  length: MatchLength;
  mapId: string;
  botStrategy?: string;
  /** Партия по сети: повторить её кнопкой «Ещё раз» нельзя. */
  network?: boolean;
}

const DIFFICULTY_LABELS: { id: Difficulty; label: string; hint: string }[] = [
  { id: "easy", label: "Лёгкая", hint: "Можно ошибиться" },
  { id: "normal", label: "Средняя", hint: "Надо думать" },
  { id: "hard", label: "Хардкор", hint: "Как в варкрафте" },
];

const LENGTH_LABELS: { id: MatchLength; label: string; hint: string }[] = [
  { id: "quick", label: "Быстрая", hint: "20 волн" },
  { id: "classic", label: "Классика", hint: "40 волн" },
  { id: "endless", label: "Бесконечная", hint: "До поражения" },
];

const MODE_LABELS: { id: GameMode | "bot"; label: string; hint: string }[] = [
  { id: "solo", label: "Соло", hint: "Выжить как можно дольше" },
  { id: "bot", label: "С ботом", hint: "Версус против ИИ" },
  { id: "versus", label: "Версус", hint: "Против брата по сети" },
  { id: "coop", label: "Кооп", hint: "Вместе по сети" },
];

export class App {
  private root: HTMLElement;
  private session: GameSession | null = null;
  private screen: GameScreenHandles | null = null;
  private client: RoomClient | null = null;

  private setup: MatchSetup;

  constructor(root: HTMLElement) {
    this.root = root;
    const saved = loadSettings();
    this.setup = {
      mode: "solo",
      difficulty: saved.difficulty ?? "normal",
      length: saved.length ?? "classic",
      mapId: saved.mapId ?? MAPS[0]!.id,
    };
  }

  showMenu(): void {
    this.teardown();
    clear(this.root);

    const menu = el("div", { class: "menu" });
    menu.append(
      el("h1", { class: "menu__title", text: "ELEMENT TD" }),
      el("p", {
        class: "menu__subtitle",
        text: "Волны идут по лабиринту. Ставь башни шести стихий, качай их и не дай никому дойти до базы.",
      }),
    );

    let selectedMode: GameMode | "bot" = "solo";

    menu.append(
      this.choiceGroup("Режим", MODE_LABELS, selectedMode, (id) => {
        selectedMode = id;
      }),
      this.choiceGroup(
        "Сложность",
        DIFFICULTY_LABELS,
        this.setup.difficulty,
        (id) => {
          this.setup.difficulty = id;
        },
      ),
      this.choiceGroup(
        "Длина партии",
        LENGTH_LABELS,
        this.setup.length,
        (id) => {
          this.setup.length = id;
        },
      ),
      this.choiceGroup(
        "Карта",
        MAPS.map((m) => ({
          id: m.id,
          label: m.label,
          hint: `${m.buildCells.length} площадок`,
        })),
        this.setup.mapId,
        (id) => {
          this.setup.mapId = id;
        },
      ),
    );

    const playBtn = el("button", { class: "btn btn--primary", text: "Играть" });
    playBtn.style.minWidth = "220px";
    playBtn.addEventListener("click", () => {
      saveSettings({
        difficulty: this.setup.difficulty,
        length: this.setup.length,
        mapId: this.setup.mapId,
      });

      if (selectedMode === "bot") {
        this.startMatch({
          ...this.setup,
          mode: "versus",
          botStrategy: "aggressive",
        });
      } else if (selectedMode === "solo") {
        this.startMatch({ ...this.setup, mode: "solo" });
      } else {
        this.showLobby(selectedMode);
      }
    });

    const helpBtn = el("button", { class: "btn", text: "Как играть" });
    helpBtn.addEventListener("click", () => this.showHelp());

    menu.append(el("div", { class: "menu__section" }, [playBtn]));
    menu.append(el("div", { class: "menu__section" }, [helpBtn]));

    const records = loadRecords();
    if (records.length > 0) {
      const best = records[0]!;
      menu.append(
        el("p", {
          class: "menu__subtitle",
          text: `Лучший результат: ${best.waves} волн · ${DIFFICULTY_LABELS.find((d) => d.id === best.difficulty)?.label ?? best.difficulty}`,
        }),
      );
    }

    this.root.append(menu);

    // Правила показываем сами при первом заходе: по ссылке от друга человек
    // попадает сюда без всяких объяснений и должен понять игру за минуту.
    if (!hasSeenHelp()) {
      markHelpSeen();
      this.showHelp();
    }
  }

  private choiceGroup<T extends string>(
    title: string,
    options: { id: T; label: string; hint: string }[],
    initial: T,
    onPick: (id: T) => void,
  ): HTMLElement {
    const row = el("div", { class: "choices" });
    const buttons: HTMLButtonElement[] = [];

    for (const option of options) {
      const button = el(
        "button",
        {
          class: "choice",
          "aria-pressed": String(option.id === initial),
        },
        [option.label, el("small", { text: option.hint })],
      ) as HTMLButtonElement;

      button.addEventListener("click", () => {
        for (const other of buttons)
          other.setAttribute("aria-pressed", "false");
        button.setAttribute("aria-pressed", "true");
        onPick(option.id);
        sound.build();
      });

      buttons.push(button);
      row.append(button);
    }

    return el("div", { class: "menu__section" }, [
      el("label", { class: "menu__label", text: title }),
      row,
    ]);
  }

  private startMatch(setup: MatchSetup): void {
    this.teardown();
    clear(this.root);

    const screen = createGameScreen(
      () => this.session!,
      () => this.showMenu(),
    );
    this.root.append(screen.root);
    this.screen = screen;

    const seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
    this.session = new GameSession(
      screen.canvas,
      {
        mode: setup.mode,
        difficulty: setup.difficulty,
        length: setup.length,
        mapId: setup.mapId,
        seed,
      },
      {
        onStateChange: (state) => screen.update(state),
        onGameOver: (state) => this.showResult(state, setup),
      },
      setup.botStrategy,
    );

    // Поле соперника показываем только когда оно вообще есть.
    if (setup.mode === "versus" || setup.mode === "coop") {
      this.session.attachMinimap(screen.rivalCanvas);
    } else {
      screen.setRivalVisible(false);
    }

    // Размер холста известен только после вставки в документ.
    requestAnimationFrame(() => {
      this.session?.resize();
      this.session?.start();
    });
  }

  /** Сетевая партия: сначала комната, потом та же самая игра. */
  private showLobby(mode: "versus" | "coop"): void {
    createLobbyScreen(
      this.root,
      mode,
      {
        difficulty: this.setup.difficulty,
        length: this.setup.length,
        mapId: this.setup.mapId,
      },
      (result) => this.startNetworkMatch(result),
      () => this.showMenu(),
    );
  }

  private startNetworkMatch(result: LobbyResult): void {
    const { client, config, isHost, you } = result;
    this.teardown();
    clear(this.root);
    this.client = client;

    const screen = createGameScreen(
      () => this.session!,
      () => {
        client.close();
        this.showMenu();
      },
    );
    this.root.append(screen.root);
    this.screen = screen;

    const session = new GameSession(
      screen.canvas,
      {
        mode: config.mode,
        difficulty: config.difficulty,
        length: config.length,
        mapId: config.mapId,
        seed: config.seed,
      },
      {
        onStateChange: (state) => screen.update(state),
        onGameOver: (state) =>
          this.showResult(
            state,
            {
              mode: config.mode,
              difficulty: config.difficulty,
              length: config.length,
              mapId: config.mapId,
              network: true,
            },
            config.mode === "coop" ? 0 : you,
          ),
      },
    );

    // В коопе поле общее, поэтому оба управляют нулевым.
    // В версусе у каждого своё: хост играет за первое, гость за второе.
    const field = config.mode === "coop" ? 0 : you;
    session.attachNetwork({
      role: isHost ? "host" : "guest",
      client,
      field,
    });

    session.attachMinimap(screen.rivalCanvas);

    client.onSnapshotReceived = (snapshot) => session.applySnapshot(snapshot);
    // Поле определяется отправителем: в коопе оно общее, в версусе своё
    // у каждого. Команду «за соседа» хост принимать не должен.
    client.onRemoteCommand = (cmd, from) =>
      session.enqueueRemote(cmd, config.mode === "coop" ? 0 : from);
    // Партию считает только хост. Если он ушёл, гостю незачем смотреть
    // в застывшее поле — говорим прямо и возвращаем в меню.
    // Просадка сети у хоста выглядит так же, как его уход: сервер сразу
    // сообщает «хост ушёл», хотя клиент хоста переподключается за секунду.
    // Гостю давалась отсрочка только на своих обрывах, а на чужих партия
    // обрывалась мгновенно. Ждём столько же, сколько ждёт хост.
    let hostGoneTimer: number | null = null;
    client.onHostGone = () => {
      if (hostGoneTimer !== null) return;
      hostGoneTimer = window.setTimeout(() => {
        hostGoneTimer = null;
        if (this.session?.state.over) return;
        if (client.players.length >= 2) return;
        this.session?.stop();
        this.showInterrupted(
          "Хост вышел из игры",
          "Второй игрок закрыл вкладку или потерял связь и не вернулся.",
        );
      }, RECONNECT_GRACE_MS);
    };

    // Обрыв связи посреди партии раньше сообщался в панель лобби, которой
    // к этому моменту уже нет в документе — игрок просто смотрел в замерший экран.
    client.onConnectionLost = (message) => {
      this.session?.stop();
      this.showInterrupted("Связь потеряна", message);
    };

    // Уход соперника видит и хост. Но короткий разрыв связи выглядит так же,
    // как уход, поэтому даём время на переподключение и только потом
    // заканчиваем партию — иначе секундная просадка сети хоронила игру.
    let rosterTimer: number | null = null;
    client.onRoster = (players) => {
      if (rosterTimer !== null) {
        window.clearTimeout(rosterTimer);
        rosterTimer = null;
      }
      if (players.length >= 2 || this.session?.state.over) return;

      rosterTimer = window.setTimeout(() => {
        if (this.session?.state.over) return;
        if (client.players.length >= 2) return;
        this.session?.stop();
        this.showInterrupted(
          "Соперник вышел",
          "Второй игрок покинул комнату и не вернулся. Партию можно начать заново из меню.",
        );
      }, RECONNECT_GRACE_MS);
    };

    this.session = session;
    requestAnimationFrame(() => {
      this.session?.resize();
      this.session?.start();
    });
  }

  /** Партия оборвалась не по правилам: сеть, ушедший игрок и тому подобное. */
  private showInterrupted(title: string, text: string): void {
    // Причин оборваться несколько (ушёл хост, опустела комната, пропала
    // связь), и раньше они показывались одна поверх другой.
    if (this.root.querySelector(".overlay")) return;
    const overlay = el("div", { class: "overlay" });
    const panel = el("div", { class: "panel" }, [
      el("h2", { text: title }),
      el("p", { text }),
    ]);
    const toMenu = el("button", { class: "btn btn--primary", text: "В меню" });
    toMenu.addEventListener("click", () => {
      overlay.remove();
      this.showMenu();
    });
    panel.append(toMenu);
    overlay.append(panel);
    this.root.append(overlay);
  }

  private showResult(
    state: GameState,
    setup: MatchSetup,
    playerIndex = 0,
  ): void {
    // Смотреть надо на своё поле: у гостя сетевого версуса нулевое поле
    // принадлежит хосту, и экран показывал чужой результат с обратным
    // вердиктом — выиграл, а написано «Поражение».
    const field = state.fields[playerIndex] ?? state.fields[0]!;
    const won = state.winner === playerIndex;
    saveRecord({
      waves: field.stats.wavesSurvived,
      difficulty: setup.difficulty,
      length: setup.length,
      mapId: setup.mapId,
      won,
    });

    const overlay = el("div", { class: "overlay" });
    const panel = el("div", { class: "panel" }, [
      el("h2", { text: won ? "Победа" : "Поражение" }),
      el("p", {
        text: won
          ? "Все волны отбиты. База цела."
          : `База пала на ${field.stats.wavesSurvived + 1}-й волне.`,
      }),
      el("div", { class: "result__stats" }, [
        el("div", {}, [
          el("b", { text: String(field.stats.wavesSurvived) }),
          "волн пережито",
        ]),
        el("div", {}, [
          el("b", { text: String(field.stats.creepsKilled) }),
          "убито",
        ]),
        el("div", {}, [
          el("b", { text: String(field.stats.creepsLeaked) }),
          "прорвалось",
        ]),
        el("div", {}, [
          el("b", { text: formatNumber(field.stats.goldEarned) }),
          "золота заработано",
        ]),
      ]),
    ]);

    const buttons: HTMLElement[] = [];

    // Сетевую партию нельзя просто «повторить»: соперник за это время мог
    // закрыть вкладку, а прежний запуск создавал локальный матч с пустым
    // вторым полем и оставлял сокет висеть.
    if (!setup.network) {
      const again = el("button", {
        class: "btn btn--primary",
        text: "Ещё раз",
      });
      again.addEventListener("click", () => {
        overlay.remove();
        this.startMatch(setup);
      });
      buttons.push(again);
    }

    const toMenu = el("button", {
      class: setup.network ? "btn btn--primary" : "btn",
      text: "В меню",
    });
    toMenu.addEventListener("click", () => {
      overlay.remove();
      this.showMenu();
    });
    buttons.push(toMenu);

    panel.append(...buttons);
    overlay.append(panel);
    this.root.append(overlay);
  }

  private showHelp(): void {
    const overlay = el("div", { class: "overlay" });
    const panel = el("div", { class: "panel" }, [
      el("h2", { text: "Как играть" }),
      el("p", {
        text: "Монстры идут по дороге от портала к базе. Каждый дошедший забирает жизнь. Кончились жизни — партия окончена.",
      }),
      el("ul", {}, [
        el("li", {
          text: "Выбери башню внизу и нажми на светлую площадку рядом с дорогой.",
        }),
        el("li", {
          text: "Нажми на свою башню, чтобы улучшить её, продать или сменить приоритет цели.",
        }),
        el("li", {
          text: "Площадки кончаются раньше золота — с середины партии придётся качать уровни, а не расширяться.",
        }),
        el("li", {
          text: "Земля не бьёт по воздуху. Летающие срезают лабиринт по прямой — держи против них что-то в центре.",
        }),
        el("li", {
          text: "Свет не стреляет, а усиливает соседние башни. Лёд почти не бьёт, но замедляет — против быстрых это единственный ответ.",
        }),
        el("li", {
          text: "Две соседние башни разных стихий можно слить в комбо: оно бьёт сильнее, накладывает эффекты обеих и освобождает площадку. Кнопки слияния появляются в панели выбранной башни.",
        }),
        el("li", {
          text: "Вызвать волну раньше — золото за оставшееся время. Рискованно: волны наложатся.",
        }),
      ]),
      el("p", {
        text: "Клавиши: 1–6 — башни, N — волна раньше, F — скорость, пробел — пауза, Tab — поменять поля местами.",
      }),
    ]);

    const close = el("button", { class: "btn btn--primary", text: "Понятно" });
    close.addEventListener("click", () => overlay.remove());
    panel.append(close);
    overlay.append(panel);
    this.root.append(overlay);
  }

  private teardown(): void {
    this.session?.stop();
    this.session = null;
    this.screen?.destroy();
    this.screen = null;
    // Соединение переживало выход из партии: сокет и таймер проверки связи
    // продолжали работать и стучаться в разрушенный экран.
    this.client?.close();
    this.client = null;
  }
}
