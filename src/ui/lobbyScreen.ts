/**
 * Лобби сетевой партии: создать комнату или войти по коду.
 *
 * Код из четырёх букв, а не ссылка — его диктуют голосом по телефону, и
 * в алфавите нарочно нет I и O, чтобы не путать их с единицей и нулём.
 */

import { MAPS } from "../core/map";
import type { Difficulty, MatchLength } from "../core/types";
import { RoomClient, type ConnectionState } from "../net/client";
import {
  generateRoomCode,
  isValidRoomCode,
  type PlayerInfo,
  type RoomConfig,
} from "../net/protocol";
import { clear, el } from "./dom";

export interface LobbyResult {
  client: RoomClient;
  config: RoomConfig;
  isHost: boolean;
  you: number;
}

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: "Подключение…",
  online: "На связи",
  reconnecting: "Связь потеряна, переподключаемся…",
  closed: "Отключено",
};

export function createLobbyScreen(
  container: HTMLElement,
  mode: "versus" | "coop",
  defaults: { difficulty: Difficulty; length: MatchLength; mapId: string },
  onStart: (result: LobbyResult) => void,
  onCancel: () => void,
): () => void {
  let client: RoomClient | null = null;
  let config: RoomConfig | null = null;
  let isHost = false;
  let you = -1;

  const overlay = el("div", { class: "overlay" });
  const panel = el("div", { class: "panel" });
  overlay.append(panel);
  container.append(overlay);

  showEntry();

  function showEntry(): void {
    clear(panel);
    panel.append(
      el("h2", { text: mode === "versus" ? "Версус по сети" : "Кооп по сети" }),
      el("p", {
        text: "Один создаёт комнату и диктует код, второй его вводит. Код из четырёх букв.",
      }),
    );

    const createBtn = el("button", {
      class: "btn btn--primary",
      text: "Создать комнату",
    });
    createBtn.addEventListener("click", () =>
      joinRoom(generateRoomCode(), true),
    );

    const input = el("input", {
      class: "btn",
      placeholder: "КОД",
      maxlength: 4,
      autocapitalize: "characters",
      autocomplete: "off",
      spellcheck: "false",
    }) as HTMLInputElement;
    input.style.textAlign = "center";
    input.style.letterSpacing = "0.4em";
    input.style.fontSize = "22px";
    input.style.width = "100%";

    const joinBtn = el("button", {
      class: "btn",
      text: "Войти",
    }) as HTMLButtonElement;
    const tryJoin = (): void => {
      const code = input.value.trim().toUpperCase();
      if (!isValidRoomCode(code)) {
        input.style.borderColor = "var(--blood)";
        return;
      }
      joinRoom(code, false);
    };
    joinBtn.addEventListener("click", tryJoin);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") tryJoin();
    });
    input.addEventListener("input", () => {
      input.value = input.value.toUpperCase().replace(/[^A-HJ-NP-Z]/g, "");
      input.style.borderColor = "";
    });

    const cancel = el("button", { class: "btn", text: "Назад" });
    cancel.addEventListener("click", () => {
      destroy();
      onCancel();
    });

    panel.append(createBtn, input, joinBtn, cancel);
    input.focus();
  }

  function joinRoom(code: string, asHost: boolean): void {
    isHost = asHost;
    config = {
      mode,
      difficulty: defaults.difficulty,
      length: defaults.length,
      mapId: defaults.mapId,
      // Сид общий: карта и порядок волн должны совпасть у обоих.
      seed: (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0,
    };

    client = new RoomClient(code, asHost ? "Хост" : "Гость", {
      onJoined: (index, host, players) => {
        you = index;
        isHost = host;
        showRoom(code, players);
        if (host && config) client?.send({ t: "config", config });
      },
      onPlayers: (players) => showRoom(code, players),
      onConfig: (received) => {
        config = received;
        showRoom(code, client?.players ?? []);
      },
      onStart: (received) => {
        config = received;
        if (!client) return;
        const result: LobbyResult = { client, config, isHost, you };
        overlay.remove();
        onStart(result);
      },
      onStateChange: () => showRoom(code, client?.players ?? []),
      onError: (message) => showError(message),
      onHostLeft: () => showError("Хост вышел из комнаты"),
    });
    client.connect();
    showRoom(code, []);
  }

  function showRoom(code: string, players: PlayerInfo[]): void {
    if (!client) return;
    clear(panel);

    panel.append(
      el("h2", { text: `Комната ${code}` }),
      el("p", {
        text: isHost
          ? "Продиктуй код второму игроку. Как только он войдёт — начинай."
          : "Ждём, пока хост начнёт партию.",
      }),
    );

    const code_ = el("div", { text: code });
    code_.style.cssText =
      "font-size:44px;letter-spacing:0.35em;text-align:center;color:var(--gold);font-weight:700;padding:6px 0 6px 12px;";
    panel.append(code_);

    panel.append(
      el("p", {
        text: `${CONNECTION_LABEL[client.connection]} · игроков: ${players.length} из 2${
          client.latency > 0 ? ` · задержка ${client.latency} мс` : ""
        }`,
      }),
    );

    if (config) {
      const map = MAPS.find((m) => m.id === config!.mapId);
      panel.append(
        el("p", {
          text: `Карта: ${map?.label ?? config.mapId} · сложность и длина как в меню`,
        }),
      );
    }

    if (isHost) {
      const startBtn = el("button", {
        class: "btn btn--primary",
        text: players.length >= 2 ? "Начать партию" : "Ждём второго игрока",
      }) as HTMLButtonElement;
      // Партию вдвоём нет смысла начинать в одиночку — второе поле будет пустым.
      startBtn.disabled = players.length < 2;
      startBtn.addEventListener("click", () => client?.send({ t: "start" }));
      panel.append(startBtn);
    }

    const leave = el("button", { class: "btn", text: "Выйти" });
    leave.addEventListener("click", () => {
      destroy();
      onCancel();
    });
    panel.append(leave);
  }

  function showError(message: string): void {
    clear(panel);
    panel.append(
      el("h2", { text: "Не получилось" }),
      el("p", { text: message }),
    );
    const back = el("button", { class: "btn btn--primary", text: "Назад" });
    back.addEventListener("click", () => {
      client?.close();
      client = null;
      showEntry();
    });
    panel.append(back);
  }

  function destroy(): void {
    client?.close();
    client = null;
    overlay.remove();
  }

  return destroy;
}
