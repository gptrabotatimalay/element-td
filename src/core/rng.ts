/**
 * Детерминированный генератор случайных чисел.
 *
 * В симуляции НЕЛЬЗЯ использовать Math.random() — иначе одинаковый сид даст
 * разный результат, и рассыплется всё: реплеи, сетевая сверка, автотесты баланса.
 * Состояние генератора живёт внутри состояния игры и сохраняется вместе с ним.
 */

/** Один шаг mulberry32. Возвращает новое состояние и число в [0, 1). */
export function nextRandom(state: number): { state: number; value: number } {
  let s = (state + 0x6d2b79f5) | 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { state: s, value: ((t ^ (t >>> 14)) >>> 0) / 4294967296 };
}

/**
 * Изменяемая обёртка — удобнее в горячем цикле симуляции.
 * Состояние читается через .state, чтобы сохранить его в снапшот.
 */
export class Rng {
  constructor(public state: number) {}

  /** Число в [0, 1). */
  next(): number {
    const r = nextRandom(this.state);
    this.state = r.state;
    return r.value;
  }

  /** Целое в [min, max] включительно. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Срабатывание с вероятностью p (0..1). */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Случайный элемент массива. Для пустого массива возвращает undefined. */
  pick<T>(items: readonly T[]): T | undefined {
    if (items.length === 0) return undefined;
    return items[Math.floor(this.next() * items.length)];
  }
}

/** Сид из строки — чтобы код комнаты давал одну и ту же карту у обоих игроков. */
export function seedFromString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
