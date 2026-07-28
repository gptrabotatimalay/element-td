/**
 * Сервер игровых комнат: Cloudflare Worker плюс Durable Object.
 *
 * Одна комната — один объект. Он не считает игру, а только держит соединения
 * и пересылает сообщения: команды идут хосту, снимки состояния — остальным.
 * Поэтому нагрузка на сервер копеечная и не упирается в лимиты бесплатного
 * тарифа, сколько бы волн ни шло на поле.
 *
 * Тот же объект поднимается локально командой `wrangler dev` — аккаунт
 * Cloudflare нужен только для публикации, разрабатывать и проверять сеть
 * можно полностью на своей машине.
 */

import type {
  ClientMessage,
  PlayerInfo,
  ServerMessage,
} from "../src/net/protocol";
import { PROTOCOL_VERSION } from "../src/net/protocol";

export interface Env {
  ROOMS: DurableObjectNamespace;
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
}

/** Сколько игроков пускаем в комнату. Игра рассчитана ровно на двоих. */
const MAX_PLAYERS = 2;
/** Комната закрывается, если все ушли и никто не вернулся. */
const EMPTY_ROOM_TIMEOUT_MS = 60_000;

interface Participant {
  socket: WebSocket;
  index: number;
  name: string;
  connected: boolean;
}

export class GameRoom {
  private participants: Participant[] = [];
  private hostIndex = 0;
  private config: unknown = null;
  private started = false;
  private closeTimer: number | null = null;

  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {
    void this.env;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Ожидается websocket", { status: 426 });
    }

    const url = new URL(request.url);
    const code = url.searchParams.get("code") ?? "????";

    if (this.participants.filter((p) => p.connected).length >= MAX_PLAYERS) {
      // Отказ отправляем через сокет, иначе браузер покажет невнятную ошибку.
      const pair = new WebSocketPair();
      const server = pair[1];
      server.accept();
      this.send(server, { t: "error", message: "Комната уже занята" });
      server.close(1000, "full");
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const index = this.nextFreeIndex();
    const participant: Participant = {
      socket: server,
      index,
      name: `Игрок ${index + 1}`,
      connected: true,
    };
    this.participants.push(participant);
    this.cancelClose();

    server.addEventListener("message", (event: MessageEvent) => {
      this.onMessage(participant, event.data, code);
    });
    const drop = (): void => this.onDisconnect(participant);
    server.addEventListener("close", drop);
    server.addEventListener("error", drop);

    return new Response(null, { status: 101, webSocket: client });
  }

  private nextFreeIndex(): number {
    const taken = new Set(
      this.participants.filter((p) => p.connected).map((p) => p.index),
    );
    for (let i = 0; i < MAX_PLAYERS; i++) if (!taken.has(i)) return i;
    return this.participants.length;
  }

  private onMessage(from: Participant, raw: unknown, code: string): void {
    let message: ClientMessage;
    try {
      message = JSON.parse(String(raw)) as ClientMessage;
    } catch {
      this.send(from.socket, { t: "error", message: "Испорченное сообщение" });
      return;
    }

    switch (message.t) {
      case "join": {
        if (message.version !== PROTOCOL_VERSION) {
          this.send(from.socket, {
            t: "error",
            message: "Разные версии игры — обновите страницу у обоих",
          });
          return;
        }
        from.name = message.name.slice(0, 24) || from.name;
        // Хост — тот, кто вошёл первым и всё ещё в комнате.
        if (this.participants.filter((p) => p.connected).length === 1) {
          this.hostIndex = from.index;
        }
        this.send(from.socket, {
          t: "joined",
          you: from.index,
          host: from.index === this.hostIndex,
          code,
          players: this.playerList(),
        });
        this.broadcast(
          {
            t: "players",
            players: this.playerList(),
            hostIndex: this.hostIndex,
          },
          null,
        );
        // Опоздавший должен сразу узнать настройки уже идущей партии.
        if (this.config && this.started) {
          this.send(from.socket, { t: "start", config: this.config as never });
        } else if (this.config) {
          this.send(from.socket, { t: "config", config: this.config as never });
        }
        return;
      }

      case "config": {
        if (from.index !== this.hostIndex) return;
        this.config = message.config;
        this.broadcast({ t: "config", config: message.config }, from.index);
        return;
      }

      case "start": {
        if (from.index !== this.hostIndex || !this.config) return;
        this.started = true;
        this.broadcast({ t: "start", config: this.config as never }, null);
        return;
      }

      case "cmd": {
        // Команды нужны только хосту — он единственный, кто считает партию.
        const host = this.participants.find(
          (p) => p.index === this.hostIndex && p.connected,
        );
        if (host)
          this.send(host.socket, {
            t: "cmd",
            from: from.index,
            cmd: message.cmd,
          });
        return;
      }

      case "snap": {
        if (from.index !== this.hostIndex) return;
        this.broadcast({ t: "snap", snapshot: message.snapshot }, from.index);
        return;
      }

      case "over": {
        if (from.index !== this.hostIndex) return;
        this.started = false;
        this.broadcast(
          { t: "over", winner: message.winner, reason: message.reason },
          from.index,
        );
        return;
      }

      case "ping": {
        this.send(from.socket, { t: "pong", sent: message.sent });
        return;
      }
    }
  }

  private onDisconnect(participant: Participant): void {
    if (!participant.connected) return;
    participant.connected = false;
    this.participants = this.participants.filter((p) => p !== participant);

    // Без хоста считать партию некому — честно говорим об этом второму.
    if (participant.index === this.hostIndex && this.started) {
      this.started = false;
      this.broadcast({ t: "hostLeft" }, null);
    }

    this.broadcast(
      { t: "players", players: this.playerList(), hostIndex: this.hostIndex },
      null,
    );

    if (this.participants.length === 0) this.scheduleClose();
  }

  private playerList(): PlayerInfo[] {
    return this.participants
      .filter((p) => p.connected)
      .map((p) => ({ index: p.index, name: p.name, connected: true }));
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // Сокет уже закрыт — обработается событием close.
    }
  }

  private broadcast(message: ServerMessage, except: number | null): void {
    for (const participant of this.participants) {
      if (!participant.connected) continue;
      if (except !== null && participant.index === except) continue;
      this.send(participant.socket, message);
    }
  }

  private scheduleClose(): void {
    this.cancelClose();
    this.closeTimer = setTimeout(() => {
      this.config = null;
      this.started = false;
    }, EMPTY_ROOM_TIMEOUT_MS) as unknown as number;
  }

  private cancelClose(): void {
    if (this.closeTimer !== null) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/room") {
      const code = (url.searchParams.get("code") ?? "").toUpperCase();
      if (!/^[A-HJ-NP-Z]{4}$/.test(code)) {
        return new Response("Неверный код комнаты", { status: 400 });
      }
      // Имя объекта выводим из кода — значит оба игрока попадут в одну комнату.
      const id = env.ROOMS.idFromName(code);
      return env.ROOMS.get(id).fetch(request);
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },
};
