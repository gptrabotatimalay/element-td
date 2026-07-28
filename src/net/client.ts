/**
 * Клиент комнаты: соединение, переподключение, отправка и приём.
 *
 * Всё сетевое общение проходит здесь, чтобы игровой код ничего не знал о
 * вебсокетах. Разрыв связи — обычное дело на телефоне (заблокировали экран,
 * переключились на мессенджер), поэтому клиент переподключается сам.
 */

import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type PlayerInfo,
  type RoomConfig,
  type ServerMessage,
  type Snapshot,
} from "./protocol";
import type { Command } from "../core/types";

export type ConnectionState =
  "connecting" | "online" | "reconnecting" | "closed";

export interface RoomHandlers {
  onJoined?: (you: number, isHost: boolean, players: PlayerInfo[]) => void;
  onPlayers?: (players: PlayerInfo[], hostIndex: number) => void;
  onConfig?: (config: RoomConfig) => void;
  onStart?: (config: RoomConfig) => void;
  onCommand?: (from: number, cmd: Command) => void;
  onSnapshot?: (snapshot: Snapshot) => void;
  onOver?: (winner: number | null, reason: string) => void;
  onHostLeft?: () => void;
  onError?: (message: string) => void;
  onStateChange?: (state: ConnectionState) => void;
  onLatency?: (ms: number) => void;
}

/** Пауза перед повторной попыткой, растёт до максимума. */
const RETRY_BASE_MS = 700;
const RETRY_MAX_MS = 6000;
/**
 * После скольких неудачных попыток перестаём молча дёргаться и говорим прямо.
 *
 * Игру можно открыть там, где сервера комнат просто нет — например на витрине
 * GitHub Pages. Бесконечное «подключение…» в таком месте выглядит поломкой,
 * хотя это ожидаемое поведение, и человеку надо об этом сказать.
 */
const RETRIES_BEFORE_GIVING_UP = 4;
const PING_INTERVAL_MS = 3000;

export function roomUrl(code: string): string {
  const { protocol, hostname, host } = window.location;
  const scheme = protocol === "https:" ? "wss:" : "ws:";
  // При локальной разработке страница отдаётся Vite на 5173, а комнаты живут
  // в `wrangler dev` на 8787 — это единственное место, где адреса расходятся.
  const isViteDev = window.location.port === "5173";
  const target = isViteDev ? `${hostname}:8787` : host;
  return `${scheme}//${target}/room?code=${encodeURIComponent(code)}`;
}

export class RoomClient {
  private socket: WebSocket | null = null;
  private retries = 0;
  private retryTimer: number | null = null;
  private pingTimer: number | null = null;
  private closedByUs = false;

  you = -1;
  isHost = false;

  /**
   * Дополнительные приёмники, которые вешает игровая сессия уже после
   * лобби. Обработчики из конструктора отвечают за комнату, эти — за партию.
   */
  onSnapshotReceived: ((snapshot: Snapshot) => void) | null = null;
  onRemoteCommand: ((cmd: Command, from: number) => void) | null = null;
  /** Хост пропал уже посреди партии — считать её больше некому. */
  onHostGone: (() => void) | null = null;
  /** Связь потеряна окончательно, уже во время партии. */
  onConnectionLost: ((message: string) => void) | null = null;
  /** Состав комнаты изменился: кто-то вошёл или вышел. */
  onRoster: ((players: PlayerInfo[]) => void) | null = null;
  players: PlayerInfo[] = [];
  latency = 0;
  connection: ConnectionState = "connecting";

  constructor(
    readonly code: string,
    private readonly playerName: string,
    private readonly handlers: RoomHandlers,
  ) {}

  connect(): void {
    this.closedByUs = false;
    this.setConnection(this.retries === 0 ? "connecting" : "reconnecting");

    let socket: WebSocket;
    try {
      socket = new WebSocket(roomUrl(this.code));
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.retries = 0;
      this.setConnection("online");
      this.send({
        t: "join",
        version: PROTOCOL_VERSION,
        name: this.playerName,
      });
      this.startPing();
    });

    socket.addEventListener("message", (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      this.handle(message);
    });

    socket.addEventListener("close", () => {
      this.stopPing();
      if (this.closedByUs) {
        this.setConnection("closed");
        return;
      }
      this.scheduleRetry();
    });

    socket.addEventListener("error", () => {
      // Подробности приходят следующим событием close — там и разбираемся.
    });
  }

  private handle(message: ServerMessage): void {
    switch (message.t) {
      case "joined":
        this.you = message.you;
        this.isHost = message.host;
        this.players = message.players;
        this.handlers.onJoined?.(message.you, message.host, message.players);
        break;
      case "players":
        this.players = message.players;
        // Хост мог смениться, пока нас не было.
        this.isHost = message.hostIndex === this.you;
        this.handlers.onPlayers?.(message.players, message.hostIndex);
        this.onRoster?.(message.players);
        break;
      case "config":
        this.handlers.onConfig?.(message.config);
        break;
      case "start":
        this.handlers.onStart?.(message.config);
        break;
      case "cmd":
        this.handlers.onCommand?.(message.from, message.cmd);
        this.onRemoteCommand?.(message.cmd, message.from);
        break;
      case "snap":
        this.handlers.onSnapshot?.(message.snapshot);
        this.onSnapshotReceived?.(message.snapshot);
        break;
      case "over":
        this.handlers.onOver?.(message.winner, message.reason);
        break;
      case "hostLeft":
        this.handlers.onHostLeft?.();
        this.onHostGone?.();
        break;
      case "pong":
        this.latency = Math.round(performance.now() - message.sent);
        this.handlers.onLatency?.(this.latency);
        break;
      case "error":
        this.handlers.onError?.(message.message);
        break;
    }
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  sendCommand(cmd: Command): void {
    this.send({ t: "cmd", cmd });
  }

  sendSnapshot(snapshot: Snapshot): void {
    this.send({ t: "snap", snapshot });
  }

  close(): void {
    this.closedByUs = true;
    this.stopPing();
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.socket?.close();
    this.socket = null;
    this.setConnection("closed");
  }

  private scheduleRetry(): void {
    if (this.closedByUs) return;

    if (this.retries >= RETRIES_BEFORE_GIVING_UP) {
      this.closedByUs = true;
      this.setConnection("closed");
      // Если мы уже были в комнате, дело не в отсутствии сервера, а в
      // потерянной связи — и говорить надо именно это.
      const message =
        this.you >= 0
          ? "Связь с комнатой потеряна. Партию продолжить не получится."
          : "Сервер комнат недоступен. Сетевая игра работает только там, " +
            "где запущен сервер: локально командой «npm run worker» или на " +
            "опубликованной версии. Соло и версус с ботом доступны всегда.";
      this.handlers.onError?.(message);
      this.onConnectionLost?.(message);
      return;
    }

    this.setConnection("reconnecting");
    const delay = Math.min(RETRY_BASE_MS * 2 ** this.retries, RETRY_MAX_MS);
    this.retries++;
    this.retryTimer = window.setTimeout(() => this.connect(), delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = window.setInterval(() => {
      this.send({ t: "ping", sent: performance.now() });
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private setConnection(state: ConnectionState): void {
    if (this.connection === state) return;
    this.connection = state;
    this.handlers.onStateChange?.(state);
  }
}
