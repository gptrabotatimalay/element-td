/**
 * Протокол сетевой игры.
 *
 * Схема — «хост считает, гость смотрит»: партию симулирует только тот, кто
 * создал комнату, и рассылает снимки состояния. Гость ничего не считает,
 * он рисует полученное и отправляет свои команды хосту.
 *
 * Почему не одинаковая симуляция у обоих (это было бы дешевле по трафику):
 * ноутбук и айфон — это Chrome и Safari, разные движки JavaScript. Они
 * по-разному округляют результаты Math.pow и Math.hypot в последнем знаке.
 * Для обычного кода это незаметно, но в симуляции ошибка накапливается, и
 * через пару минут у игроков разные партии. Ловить такое ночью вслепую —
 * гарантированный способ не доделать сеть вообще.
 */

import type {
  Command,
  CreepKind,
  Difficulty,
  ElementId,
  GameMode,
  MatchLength,
  TargetMode,
} from "../core/types";

/** Версия протокола: при несовпадении клиенты честно скажут об этом. */
export const PROTOCOL_VERSION = 2;

export interface RoomConfig {
  mode: Extract<GameMode, "versus" | "coop">;
  difficulty: Difficulty;
  length: MatchLength;
  mapId: string;
  seed: number;
}

// ── Клиент → сервер ─────────────────────────────────────────────────────────

export type ClientMessage =
  /** Вход в комнату. Первый вошедший становится хостом. */
  | { t: "join"; version: number; name: string }
  /** Хост задаёт настройки партии. */
  | { t: "config"; config: RoomConfig }
  /** Хост объявляет старт. */
  | { t: "start" }
  /** Команда игрока. Хост применит её к своей симуляции. */
  | { t: "cmd"; cmd: Command }
  /** Снимок состояния от хоста — рассылается всем остальным. */
  | { t: "snap"; snapshot: Snapshot }
  /** Партия закончилась. */
  | { t: "over"; winner: number | null; reason: string }
  /** Проверка задержки. */
  | { t: "ping"; sent: number };

// ── Сервер → клиент ─────────────────────────────────────────────────────────

export type ServerMessage =
  /** Подтверждение входа: кто ты в этой комнате. */
  | {
      t: "joined";
      you: number;
      host: boolean;
      code: string;
      players: PlayerInfo[];
    }
  /** Состав комнаты изменился. */
  | { t: "players"; players: PlayerInfo[]; hostIndex: number }
  | { t: "config"; config: RoomConfig }
  | { t: "start"; config: RoomConfig }
  | { t: "cmd"; from: number; cmd: Command }
  | { t: "snap"; snapshot: Snapshot }
  | { t: "over"; winner: number | null; reason: string }
  | { t: "pong"; sent: number }
  /** Хост отвалился — партию продолжать нельзя. */
  | { t: "hostLeft" }
  | { t: "error"; message: string };

export interface PlayerInfo {
  index: number;
  name: string;
  connected: boolean;
}

// ── Снимок состояния ────────────────────────────────────────────────────────
//
// Массивы чисел вместо объектов: снимок уходит десять раз в секунду, и
// подписи полей в нём весили бы больше самих данных.

/** [id, kind, x, y, hp, maxHp, флаги] — флаги: 1 замедлен, 2 заморожен, 4 горит, 8 отравлен */
export type CreepTuple = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/**
 * [id, cell, element, level, targetMode, вторая стихия или -1, вложено золота,
 * нанесено урона]
 */
export type TowerTuple = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** [x, y, element, splash] */
export type ProjectileTuple = [number, number, number, number];

export interface FieldSnapshot {
  gold: number;
  lives: number;
  wave: number;
  waveTimer: number;
  alive: boolean;
  creeps: CreepTuple[];
  towers: TowerTuple[];
  projectiles: ProjectileTuple[];
  /** Отправленные монстры и покупки жизней — для подписей в интерфейсе. */
  sentCount: number;
  healCount: number;
  /** Отправки по типам: от них зависит цена следующей отправки. */
  sentByKind: [number, number][];
  /** Итоги партии: без них экран результата у гостя показывал нули. */
  killed: number;
  leaked: number;
  earned: number;
}

export interface Snapshot {
  tick: number;
  fields: FieldSnapshot[];
  over: boolean;
  winner: number | null;
  /**
   * Стоит ли партия на паузе у хоста.
   *
   * Без этого пауза хоста просто замораживала у гостя и поле, и показатели —
   * от обрыва связи он это отличить не мог.
   */
  paused: boolean;
}

// ── Кодирование перечислений ────────────────────────────────────────────────

export const CREEP_KINDS: CreepKind[] = [
  "normal",
  "fast",
  "armored",
  "flying",
  "swarm",
  "boss",
];

export const ELEMENTS: ElementId[] = [
  "fire",
  "ice",
  "lightning",
  "earth",
  "poison",
  "light",
];

export const TARGET_MODES: TargetMode[] = [
  "first",
  "strongest",
  "fastest",
  "closest",
];

export const FLAG_SLOW = 1;
export const FLAG_FREEZE = 2;
export const FLAG_BURN = 4;
export const FLAG_POISON = 8;

/** Код комнаты: четыре буквы, которые не спутать вслух по телефону. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";

export function generateRoomCode(random: () => number = Math.random): string {
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  }
  return code;
}

export function isValidRoomCode(code: string): boolean {
  return /^[A-HJ-NP-Z]{4}$/.test(code.toUpperCase());
}
