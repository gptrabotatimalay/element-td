/**
 * Все числа игры в одном месте.
 *
 * Правила этого файла:
 *  1. Ни одно число из этого файла не подобрано «на глаз» — каждое проверяется
 *     прогоном тысяч партий (scripts/balance.ts). Если правишь — перезапусти прогон.
 *  2. Здесь только данные и чистые функции. Никакого состояния.
 *
 * Главное требование заказчика: зарабатывать не должно быть легко.
 * Как это обеспечено — см. блок «Экономика» ниже.
 */

import type {
  CreepKind,
  Difficulty,
  ElementId,
  MatchLength,
  TargetMode,
} from "./types";

/** Тиков в секунде. Фиксированный шаг симуляции. */
export const TICK_RATE = 30;

/** Логический размер игрового поля. Экран под него масштабируется. */
export const FIELD_WIDTH = 960;
export const FIELD_HEIGHT = 640;

// ─────────────────────────────────────────────────────────────────────────────
// Экономика
// ─────────────────────────────────────────────────────────────────────────────
//
// Здоровье волн растёт по экспоненте, а награда за убийство — от здоровья в
// степени меньше единицы. То есть чем дальше, тем меньшую долю нужной обороны
// окупает один монстр. Именно это не даёт заработку разогнаться: к сороковой
// волне золота на единицу здоровья приходит примерно втрое меньше, чем на первой.
//
// Показатель степени BOUNTY_EXPONENT — главный регулятор сложности. Он влияет
// на игру сильнее, чем количество жизней: жизни прощают одну ошибку, а
// показатель определяет, догоняет ли вообще оборона рост волн.

/**
 * Здоровье обычного монстра первой волны.
 * Подобрано так, чтобы двух стартовых башен хватало на первые волны с запасом:
 * игрок должен успеть понять правила, а не сливаться на обучении.
 */
export const CREEP_HP_BASE = 14;

export interface DifficultyConfig {
  /** Во сколько раз растёт здоровье каждой следующей волны. */
  hpGrowth: number;
  /** Награда = BOUNTY_BASE * (hp / CREEP_HP_BASE) ^ bountyExponent */
  bountyExponent: number;
  startGold: number;
  startLives: number;
  /** Доля возврата при продаже башни. */
  sellRefund: number;
  /** Процент от накопленного золота за волну без потерь. */
  interestRate: number;
  /** Потолок процента в золоте за волну. Без потолка накопление даёт снежный ком. */
  interestCap: number;
}

export const DIFFICULTY: Record<Difficulty, DifficultyConfig> = {
  easy: {
    hpGrowth: 1.17,
    bountyExponent: 1.0,
    startGold: 400,
    startLives: 60,
    sellRefund: 0.75,
    interestRate: 0.05,
    interestCap: 60,
  },
  normal: {
    hpGrowth: 1.20,
    bountyExponent: 0.95,
    startGold: 320,
    startLives: 35,
    sellRefund: 0.65,
    interestRate: 0.04,
    interestCap: 45,
  },
  hard: {
    // Эталонный режим. Балансим в первую очередь под него: ошибся с билдом —
    // слился, но при правильной игре проходится.
    // Подобрано прогоном (scripts/tune.ts). Цель — разумная игра выигрывает
    // примерно в трети-половине партий, а «качай одну башню», «много дешёвых
    // башен» и случайные ходы не выигрывают никогда. Ниже — хардкор становится
    // непроходимым в принципе, выше — начинает прощать плохие билды.
    // Пересматривалось дважды: когда площадок на картах стало больше и когда
    // паузу между волнами увеличили с 14 секунд до 28. Второе оказалось
    // важнее всего — при плотном потоке волны накладывались по четыре штуки,
    // и половина сложности держалась именно на этом. После разведения волн
    // давление пришлось вернуть ростом здоровья.
    hpGrowth: 1.22,
    bountyExponent: 0.885,
    startGold: 260,
    startLives: 20,
    sellRefund: 0.55,
    interestRate: 0.03,
    interestCap: 30,
  },
};

export const BOUNTY_BASE = 10;

/** Здоровье одного обычного монстра на волне waveIndex (0-based). */
export function waveHp(waveIndex: number, difficulty: Difficulty): number {
  return CREEP_HP_BASE * Math.pow(DIFFICULTY[difficulty].hpGrowth, waveIndex);
}

/** Награда за обычного монстра волны. Растёт медленнее здоровья — см. блок выше. */
export function waveBounty(waveIndex: number, difficulty: Difficulty): number {
  const cfg = DIFFICULTY[difficulty];
  const hp = waveHp(waveIndex, difficulty);
  return Math.max(
    1,
    Math.round(BOUNTY_BASE * Math.pow(hp / CREEP_HP_BASE, cfg.bountyExponent)),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Длина партии
// ─────────────────────────────────────────────────────────────────────────────

export interface LengthConfig {
  /** Сколько волн до победы. null — бесконечно. */
  totalWaves: number | null;
  /** На каких волнах приходит босс (1-based номера волн). */
  bossWaves: number[];
  label: string;
}

export const LENGTH: Record<MatchLength, LengthConfig> = {
  quick: { totalWaves: 20, bossWaves: [10, 20], label: "Быстрая" },
  classic: { totalWaves: 40, bossWaves: [10, 20, 30, 40], label: "Классика" },
  endless: { totalWaves: null, bossWaves: [], label: "Бесконечная" },
};

/** В бесконечном режиме босс приходит каждые сколько волн. */
export const ENDLESS_BOSS_EVERY = 10;

// ─────────────────────────────────────────────────────────────────────────────
// Волны
// ─────────────────────────────────────────────────────────────────────────────

/** Сколько обычных монстров в волне. */
export const CREEPS_PER_WAVE = 12;
/** Тиков между появлением монстров внутри волны. */
export const SPAWN_INTERVAL = 18;
/** Пауза перед первой волной. */
export const FIRST_WAVE_DELAY = TICK_RATE * 20;
/**
 * Пауза между волнами.
 *
 * Была 14 секунд при том, что волна живёт на поле около пятидесяти: волны шли
 * сплошным потоком, на поле одновременно висело до четырёх штук, и разобрать,
 * кто откуда идёт, было невозможно. Заодно партия «Классика» укладывалась в
 * девять минут вместо заявленных двадцати-тридцати.
 *
 * Теперь на поле полторы-две волны: предыдущая ещё догорает, когда выходит
 * следующая. Кому этого мало — есть досрочный призыв.
 */
export const WAVE_INTERVAL = TICK_RATE * 28;
/**
 * Доля оставшейся паузы, которая превращается в золото при досрочном призыве.
 * Снижена вместе с ростом паузы: иначе за один раш капало больше, чем за
 * убийство целой волны.
 */
export const RUSH_GOLD_PER_TICK = 0.35;

/**
 * Порядок типов волн. Повторяется по кругу; босс подменяет волну целиком.
 * Летающие идут по прямой над лабиринтом — по ним бьют не все башни,
 * поэтому они и стоят в расписании заранее видимыми.
 */
export const WAVE_PATTERN: CreepKind[] = [
  "normal",
  "normal",
  "fast",
  "normal",
  "swarm",
  "armored",
  "flying",
  "normal",
  "fast",
  "armored",
];

export interface CreepKindConfig {
  hpMult: number;
  speedMult: number;
  armor: number;
  resist: number;
  bountyMult: number;
  countMult: number;
  flying: boolean;
  /** Сколько жизней снимает, дойдя до базы. */
  leak: number;
  /** Боссов нельзя заморозить полностью — иначе они не угроза. */
  freezeImmune: boolean;
  label: string;
}

export const CREEP_KIND: Record<CreepKind, CreepKindConfig> = {
  normal: {
    hpMult: 1,
    speedMult: 1,
    armor: 0.1,
    resist: 0.1,
    bountyMult: 1,
    countMult: 1,
    flying: false,
    leak: 1,
    freezeImmune: false,
    label: "Обычные",
  },
  fast: {
    hpMult: 0.55,
    // Скорость важнее здоровья: быстрые проскакивают зону поражения, и башни
    // просто не успевают выстрелить нужное число раз. При 1.9 волна быстрых
    // сносила десять жизней из двадцати независимо от качества обороны —
    // это уже не «опасный тип», а необходимость держать лёд.
    speedMult: 1.6,
    armor: 0,
    resist: 0.05,
    bountyMult: 0.8,
    countMult: 1,
    flying: false,
    leak: 1,
    freezeImmune: false,
    label: "Быстрые",
  },
  armored: {
    // Броня режет только физический урон, а физическая стихия одна — земля.
    // Поэтому броня сама по себе почти ничего не значит, и жирность
    // бронированных держится на здоровье и сопротивлении, а не на цифре брони.
    hpMult: 1.3,
    speedMult: 0.8,
    armor: 0.6,
    resist: 0.25,
    bountyMult: 1.3,
    countMult: 1,
    flying: false,
    leak: 1,
    freezeImmune: false,
    label: "Бронированные",
  },
  flying: {
    // Летающие срезают лабиринт по прямой, и по ним стреляет заметно меньше
    // башен, чем по наземным. Пока их было двенадцать штук с обычным здоровьем,
    // волна просто продавливала оборону количеством — до базы доходили девять
    // из двенадцати при любом билде. Теперь их мало, но каждая заметная:
    // суммарного здоровья в волне меньше, чем у обычной, зато нужны башни,
    // которые вообще достают до воздуха.
    hpMult: 1.4,
    speedMult: 0.35,
    armor: 0.05,
    resist: 0.15,
    bountyMult: 2.5,
    countMult: 0.4,
    flying: true,
    leak: 1,
    freezeImmune: false,
    label: "Летающие",
  },
  swarm: {
    hpMult: 0.25,
    speedMult: 1.15,
    armor: 0,
    resist: 0,
    bountyMult: 0.35,
    countMult: 3,
    flying: false,
    leak: 1,
    freezeImmune: false,
    label: "Рой",
  },
  boss: {
    // Босс должен быть событием, а не приговором. При множителе 14 он доходил
    // до базы вообще при любой обороне и снимал пять жизней — то есть партия
    // кончалась не потому, что игрок ошибся, а по расписанию.
    hpMult: 9,
    speedMult: 0.7,
    armor: 0.25,
    resist: 0.25,
    bountyMult: 7,
    countMult: 0.1,
    flying: false,
    leak: 5,
    freezeImmune: true,
    label: "Босс",
  },
};

/**
 * Базовая скорость обычного монстра — юнитов за тик.
 * При длине маршрута около 3000 юнитов это даёт проход примерно за 40 секунд:
 * достаточно, чтобы успеть достроить башню посреди волны, и мало, чтобы скучать.
 */
export const CREEP_BASE_SPEED = 2.5;

// ─────────────────────────────────────────────────────────────────────────────
// Башни
// ─────────────────────────────────────────────────────────────────────────────
//
// Цена уровня растёт быстрее, чем урон (2.1 против 2.0). Значит прокачка одной
// башни до максимума заведомо невыгодна «в лоб» — по чистому урону на золото
// пять первых уровней проигрывают россыпи башен первого уровня примерно вдвое.
//
// Зачем тогда качать: клеток на карте ограниченное количество, а высокие уровни
// дают не цифры, а новые свойства — заморозку, лишние звенья цепи, больший
// радиус взрыва. Это и есть выбор между шириной и глубиной, ради которого
// экономика так устроена.

export const TOWER_LEVEL_MAX = 5;
/** Множитель урона за каждый уровень. */
export const LEVEL_DAMAGE_MULT = 2.0;
/** Множитель цены за каждый уровень. Намеренно больше, чем множитель урона. */
export const LEVEL_COST_MULT = 2.1;
/** Прирост скорострельности за уровень. */
export const LEVEL_RATE_MULT = 1.06;
/** Прирост дальности за уровень. */
export const LEVEL_RANGE_MULT = 1.05;

export interface ElementConfig {
  label: string;
  /** Цена постройки первого уровня. */
  baseCost: number;
  /** Урон одного выстрела на первом уровне. */
  baseDamage: number;
  /** Выстрелов в секунду на первом уровне. */
  baseRate: number;
  /** Дальность в юнитах на первом уровне. */
  baseRange: number;
  damageType: "physical" | "magical";
  canHitAir: boolean;
  /** Скорость снаряда, юнитов за тик. 0 — попадание мгновенное. */
  projectileSpeed: number;
  /** Радиус урона по площади на первом уровне. */
  splash: number;
  color: string;
  description: string;
}

export const ELEMENT: Record<ElementId, ElementConfig> = {
  fire: {
    label: "Огонь",
    baseCost: 100,
    baseDamage: 12,
    baseRate: 0.9,
    baseRange: 110,
    damageType: "magical",
    canHitAir: true,
    projectileSpeed: 9,
    splash: 0,
    color: "#ff6b35",
    description: "Поджигает: урон продолжает капать после попадания",
  },
  ice: {
    label: "Лёд",
    baseCost: 90,
    baseDamage: 9,
    baseRate: 1.1,
    baseRange: 105,
    damageType: "magical",
    canHitAir: true,
    projectileSpeed: 8,
    splash: 0,
    color: "#5ec8f2",
    description: "Замедляет, с 4 уровня иногда полностью замораживает",
  },
  lightning: {
    label: "Молния",
    baseCost: 120,
    baseDamage: 9,
    baseRate: 0.8,
    baseRange: 120,
    damageType: "magical",
    canHitAir: true,
    projectileSpeed: 0,
    splash: 0,
    color: "#ffe066",
    description: "Бьёт цепью — каждый уровень добавляет звено",
  },
  earth: {
    label: "Земля",
    baseCost: 130,
    baseDamage: 24,
    baseRate: 0.5,
    baseRange: 95,
    damageType: "physical",
    canHitAir: false,
    projectileSpeed: 6,
    splash: 42,
    color: "#8d6e4a",
    description: "Тяжёлый взрыв по площади. По воздуху не бьёт",
  },
  poison: {
    label: "Яд",
    baseCost: 95,
    baseDamage: 7,
    baseRate: 1.0,
    baseRange: 110,
    damageType: "magical",
    canHitAir: true,
    projectileSpeed: 8,
    splash: 0,
    color: "#8ddb5a",
    description: "Яд копится стаками — тем сильнее, чем жирнее цель",
  },
  light: {
    label: "Свет",
    baseCost: 140,
    baseDamage: 0,
    baseRate: 0,
    baseRange: 0,
    damageType: "magical",
    canHitAir: false,
    projectileSpeed: 0,
    splash: 0,
    color: "#fff3b0",
    description: "Не стреляет. Усиливает соседние башни",
  },
};

// Параметры особых свойств.

/**
 * Огонь: сколько секунд горит и какая доля урона выстрела уходит в горение.
 * Доля намеренно меньше половины: с 0.6 огонь по чистому урону обгонял все
 * остальные стихии вместе взятые, и моно-огонь проходил хардкор чаще, чем
 * осмысленный смешанный билд.
 */
export const BURN_SECONDS = 3;
export const BURN_DAMAGE_SHARE = 0.4;
/** С этого уровня горение усиливается. */
export const BURN_UPGRADE_LEVEL = 3;
export const BURN_UPGRADE_SHARE = 0.7;

/**
 * Лёд: сила замедления и его длительность.
 * Лёд почти не наносит урона, поэтому окупаться он должен именно замедлением —
 * при слабом эффекте его просто нет смысла ставить, и быстрые волны становятся
 * непроходимыми в принципе.
 */
export const SLOW_FACTOR_BASE = 0.65;
/** Каждый уровень добавляет к силе замедления. */
export const SLOW_FACTOR_PER_LEVEL = 0.05;
export const SLOW_SECONDS = 2;
/** С какого уровня появляется шанс заморозки. */
export const FREEZE_LEVEL = 4;
export const FREEZE_CHANCE = 0.12;
export const FREEZE_SECONDS = 0.8;

/** Молния: количество целей = 1 + уровень. Каждое звено бьёт слабее. */
export const CHAIN_FALLOFF = 0.65;
export const CHAIN_RANGE = 85;

/** Яд: длительность стака, урон за стак в секунду, потолок стаков. */
export const POISON_SECONDS = 4;
export const POISON_DPS_PER_STACK = 5;
export const POISON_MAX_STACKS_BASE = 3;
export const POISON_STACKS_PER_LEVEL = 1;

/** Свет: радиус ауры и её бонусы за уровень. */
export const AURA_RADIUS_BASE = 95;
export const AURA_RADIUS_PER_LEVEL = 12;
export const AURA_DAMAGE_PER_LEVEL = 0.12;
export const AURA_RATE_PER_LEVEL = 0.08;
export const AURA_RANGE_PER_LEVEL = 0.04;

// ─────────────────────────────────────────────────────────────────────────────
// Отправка монстров противнику (версус)
// ─────────────────────────────────────────────────────────────────────────────
//
// Отправка стоит золота сейчас и возвращается приростом дохода потом.
// Окупаемость примерно за 15 волн — то есть ранняя агрессия выгодна,
// но оголяет собственную оборону, а поздняя уже не успевает окупиться.

export interface SendConfig {
  cost: number;
  /** Прибавка к постоянному доходу за волну. */
  income: number;
  label: string;
}

export const SEND: Partial<Record<CreepKind, SendConfig>> = {
  normal: { cost: 40, income: 2.6, label: "Обычный" },
  fast: { cost: 60, income: 3.9, label: "Быстрый" },
  swarm: { cost: 70, income: 4.6, label: "Рой" },
  armored: { cost: 95, income: 6.2, label: "Бронированный" },
  flying: { cost: 125, income: 8.1, label: "Летающий" },
};

/** Каждая следующая отправка того же типа дорожает — иначе спам одним типом. */
export const SEND_COST_ESCALATION = 1.08;

// ─────────────────────────────────────────────────────────────────────────────
// Ремонт базы
// ─────────────────────────────────────────────────────────────────────────────
//
// Куда девать золото в конце партии. Без этого к тридцатой волне все площадки
// застроены, все уровни выкачаны, и половина заработанного лежит мёртвым
// грузом — то есть экономика перестаёт быть ограничением ровно тогда, когда
// должна давить сильнее всего.
//
// Цена растёт круто: одна-две жизни в трудный момент — нормальный ход,
// откупиться от плохой обороны деньгами не выйдет.

export const HEAL_BASE_COST = 250;
/**
 * Насколько дорожает каждая следующая жизнь.
 *
 * Пробовали снижать до 1.35, чтобы золото активнее уходило в конце партии, —
 * и хардкор тут же стал проходиться в 96% случаев. Покупка жизней должна
 * быть спасением в трудный момент, а не способом купить победу за накопления.
 */
export const HEAL_COST_ESCALATION = 1.5;

export function healCost(purchases: number): number {
  return Math.round(HEAL_BASE_COST * Math.pow(HEAL_COST_ESCALATION, purchases));
}

// ─────────────────────────────────────────────────────────────────────────────
// Производные значения
// ─────────────────────────────────────────────────────────────────────────────

/** Цена постройки или следующего уровня. level — уровень, который получаем. */
export function towerCost(element: ElementId, level: number): number {
  const base = ELEMENT[element].baseCost;
  return Math.round(base * Math.pow(LEVEL_COST_MULT, level - 1));
}

/** Сколько золота суммарно вложено в башню данного уровня. */
export function towerInvested(element: ElementId, level: number): number {
  let sum = 0;
  for (let l = 1; l <= level; l++) sum += towerCost(element, l);
  return sum;
}

export function towerDamage(element: ElementId, level: number): number {
  return ELEMENT[element].baseDamage * Math.pow(LEVEL_DAMAGE_MULT, level - 1);
}

/** Перезарядка в тиках. */
export function towerCooldownTicks(element: ElementId, level: number): number {
  const rate = ELEMENT[element].baseRate * Math.pow(LEVEL_RATE_MULT, level - 1);
  if (rate <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.round(TICK_RATE / rate));
}

export function towerRange(element: ElementId, level: number): number {
  return ELEMENT[element].baseRange * Math.pow(LEVEL_RANGE_MULT, level - 1);
}

/**
 * Цель по умолчанию — ближайшая к башне, а не первая по пути.
 *
 * «Первый по пути» звучит логичнее, но при трёх десятках башен все они
 * начинают бить в одного и того же лидера: он умирает от первого залпа,
 * остальной урон уходит в никуда, а хвост волны спокойно доходит до базы.
 * Ближайшая цель распределяет огонь вдоль дороги сама собой.
 * Игрок может переключить приоритет на любой башне вручную.
 */
export const DEFAULT_TARGET_MODE: TargetMode = "closest";

// ─────────────────────────────────────────────────────────────────────────────
// Комбо-башни
// ─────────────────────────────────────────────────────────────────────────────
//
// Слияние двух соседних башен разных стихий. Комбо стреляет как основная
// стихия, но накладывает эффекты обеих сразу — и занимает одну клетку вместо
// двух. В этом и выбор: суммарного урона становится меньше, зато эффекты
// складываются на одной цели, а освободившаяся площадка идёт подо что-то ещё.

/**
 * Насколько сильнее бьёт комбо по сравнению с обычной башней того же уровня.
 * При 1.45 слияние поднимало проходимость хардкора с трети до двух третей —
 * то есть переставало быть выбором и становилось обязательным ходом.
 */
export const FUSION_DAMAGE_BONUS = 1.25;
/** Доля вложенного во вторую башню, которую придётся доплатить за слияние. */
export const FUSION_COST_SHARE = 0.35;

export interface FusionRecipe {
  /** Стихии в любом порядке. */
  a: ElementId;
  b: ElementId;
  label: string;
  description: string;
}

export const FUSIONS: FusionRecipe[] = [
  {
    a: "fire",
    b: "ice",
    label: "Пар",
    description: "Обжигает и замедляет одновременно",
  },
  {
    a: "fire",
    b: "lightning",
    label: "Плазма",
    description: "Цепь молний, каждое звено поджигает",
  },
  {
    a: "fire",
    b: "earth",
    label: "Магма",
    description: "Взрыв по площади, после которого горит вся пачка",
  },
  {
    a: "ice",
    b: "lightning",
    label: "Буря",
    description: "Цепь по замедленным целям",
  },
  {
    a: "ice",
    b: "poison",
    label: "Стужа",
    description: "Замедляет и травит — против жирных лучшее, что есть",
  },
  {
    a: "earth",
    b: "poison",
    label: "Трясина",
    description: "Ядовитый взрыв по площади",
  },
  {
    a: "fire",
    b: "poison",
    label: "Скверна",
    description: "Горение и яд копятся вместе",
  },
  {
    a: "lightning",
    b: "poison",
    label: "Распад",
    description: "Цепь разносит яд по всей волне",
  },
];

/** Рецепт для пары стихий, в любом порядке. Свет не сливается ни с чем. */
export function findFusion(a: ElementId, b: ElementId): FusionRecipe | null {
  if (a === b) return null;
  return (
    FUSIONS.find(
      (recipe) =>
        (recipe.a === a && recipe.b === b) || (recipe.a === b && recipe.b === a),
    ) ?? null
  );
}

/** Название башни с учётом слияния. */
export function towerName(element: ElementId, fused: ElementId | null): string {
  if (!fused) return ELEMENT[element].label;
  return findFusion(element, fused)?.label ?? ELEMENT[element].label;
}
