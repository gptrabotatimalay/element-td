/**
 * Типы состояния игры.
 *
 * Всё, что здесь описано, должно полностью определять партию: одинаковое
 * состояние + одинаковые команды = одинаковый результат. Никаких ссылок на
 * DOM, время или картинки — этот модуль обязан запускаться в Node без браузера.
 */

export type ElementId =
  "fire" | "ice" | "lightning" | "earth" | "poison" | "light";

export type CreepKind =
  "normal" | "fast" | "armored" | "flying" | "swarm" | "boss";

export type Difficulty = "easy" | "normal" | "hard";

export type MatchLength = "quick" | "classic" | "endless";

export type GameMode = "solo" | "versus" | "coop";

export type TargetMode = "first" | "strongest" | "fastest" | "closest";

/** Тип урона. Броня режет физический, сопротивление — магический. */
export type DamageType = "physical" | "magical";

export interface Creep {
  id: number;
  kind: CreepKind;
  hp: number;
  maxHp: number;
  /** Базовая скорость в юнитах за тик, до замедлений. */
  baseSpeed: number;
  /** Доля снижения физического урона, 0..0.9 */
  armor: number;
  /** Доля снижения магического урона, 0..0.9 */
  resist: number;
  flying: boolean;
  /** Пройденное расстояние по маршруту, в юнитах. */
  progress: number;
  x: number;
  y: number;
  bounty: number;
  /** Сколько жизней снимет, если дойдёт. */
  leak: number;

  // Эффекты. Отдельными полями, а не массивом — так быстрее в прогоне
  // тысяч партий и проще держать детерминизм.
  /** Множитель скорости от замедления: 1 — нет замедления. */
  slowFactor: number;
  slowTicks: number;
  freezeTicks: number;
  burnTicks: number;
  /** Урон горения за тик. */
  burnDamage: number;
  poisonStacks: number;
  poisonTicks: number;
  /** Наложенное снижение брони (от особых эффектов), 0..1 */
  armorShred: number;
  /**
   * Урон уже летящих в эту цель снарядов.
   * Башня не выбирает того, кто и так обречён — иначе половина выстрелов
   * уходит в труп, и чем больше башен, тем сильнее этот перерасход.
   */
  incoming: number;
}

export interface Tower {
  id: number;
  /** Индекс клетки на карте. */
  cell: number;
  x: number;
  y: number;
  element: ElementId;
  /** 1..5 */
  level: number;
  /**
   * Вторая стихия, если башня получена слиянием.
   * Комбо-башня бьёт как основная стихия, но накладывает эффекты обеих.
   */
  fused: ElementId | null;
  /** Тиков до следующего выстрела. */
  cooldown: number;
  targetMode: TargetMode;
  /** Сколько золота вложено суммарно — от этого считается цена продажи. */
  invested: number;
  /** Суммарный нанесённый урон — для статистики и отладки баланса. */
  damageDealt: number;
}

export interface Projectile {
  id: number;
  x: number;
  y: number;
  targetId: number;
  speed: number;
  damage: number;
  damageType: DamageType;
  element: ElementId;
  /** Радиус урона по площади, 0 — точечный. */
  splash: number;
  /** Уровень башни, из которого вылетел — нужен для эффектов при попадании. */
  level: number;
  /** Кто выпустил — чтобы записать урон башне. */
  towerId: number;
}

/** Одно поле = один игрок. Соло и кооп — одно поле, версус — два. */
export interface Field {
  /** Индекс игрока, которому принадлежит поле. */
  owner: number;
  gold: number;
  lives: number;
  towers: Tower[];
  creeps: Creep[];
  projectiles: Projectile[];
  /** Номер следующей волны, которая придёт (0-based). */
  waveIndex: number;
  /** Тиков до начала следующей волны. */
  waveTimer: number;
  /** Очередь спавна: тик появления и описание крипа. */
  spawnQueue: SpawnEntry[];
  /** Постоянный прирост дохода за волну, накопленный отправкой монстров. */
  income: number;
  /**
   * Досрочный призыв уже использован для текущей волны.
   *
   * Без этого флага раш срабатывал каждый тик: команда обнуляла таймер, а
   * обработка волн тут же выставляла его заново на полный интервал. Игрок,
   * зажавший кнопку, получал сотни выплат и лавину волн одновременно.
   */
  rushedThisWave: boolean;
  /** Занятые клетки: индекс клетки → id башни. */
  occupied: Map<number, number>;
  /** Кэш бонусов от аур: id башни → множители. Пересчитывается при застройке. */
  auraCache: Map<number, AuraBonus>;
  alive: boolean;
  /** События прошедшего тика — для звука и вспышек. Очищается каждый тик. */
  events: GameEvent[];
  /** Статистика для автотестов баланса. */
  stats: FieldStats;
}

export interface AuraBonus {
  damageMult: number;
  rateMult: number;
  rangeMult: number;
}

export interface SpawnEntry {
  tick: number;
  kind: CreepKind;
  hp: number;
  bounty: number;
  /** true — монстра прислал противник. */
  sent: boolean;
}

export interface FieldStats {
  goldEarned: number;
  goldSpent: number;
  creepsKilled: number;
  creepsLeaked: number;
  wavesSurvived: number;
  sentCount: number;
  /** Отправок по типам монстров — цена растёт отдельно для каждого. */
  sentByKind: Partial<Record<CreepKind, number>>;
  /** Сколько раз докупали жизнь — от этого зависит цена следующей. */
  healCount: number;
}

/**
 * События за прошедший тик: что озвучить и что подсветить.
 *
 * Журнал живёт в состоянии, а не в рендере, потому что рендер не может
 * восстановить мгновенные вещи — цепь молнии или момент выстрела он просто
 * не увидит. Список очищается каждый тик и на саму симуляцию не влияет.
 */
export type GameEvent =
  | { t: "shoot"; element: ElementId; x: number; y: number }
  | { t: "chain"; points: { x: number; y: number }[] }
  | { t: "explode"; x: number; y: number; radius: number }
  | { t: "kill"; x: number; y: number; bounty: number }
  | { t: "leak"; lives: number }
  | { t: "wave"; index: number; boss: boolean };

export interface GameState {
  tick: number;
  rngState: number;
  mode: GameMode;
  difficulty: Difficulty;
  length: MatchLength;
  mapId: string;
  fields: Field[];
  nextEntityId: number;
  over: boolean;
  /** Индекс победителя, null — ничья или партия идёт. */
  winner: number | null;
  /** Причина завершения — для экрана итогов и для тестов. */
  endReason: "lives" | "waves-cleared" | "draw" | null;
}

export type Command =
  | { t: "build"; field: number; cell: number; element: ElementId }
  | { t: "upgrade"; field: number; tower: number }
  | { t: "sell"; field: number; tower: number }
  | { t: "target"; field: number; tower: number; mode: TargetMode }
  /** Отправить монстра противнику: тратит золото, повышает свой доход. */
  | { t: "send"; field: number; kind: CreepKind }
  /** Призвать следующую волну досрочно — даёт бонус к золоту. */
  | { t: "rush"; field: number }
  /** Купить жизнь. Цена растёт с каждой покупкой. */
  | { t: "heal"; field: number }
  /** Слить две соседние башни в комбо-башню. */
  | { t: "fuse"; field: number; tower: number; with: number };

/** Команда, привязанная к тику — так её передаёт сеть и так её пишет реплей. */
export interface TickCommand {
  tick: number;
  cmd: Command;
}
