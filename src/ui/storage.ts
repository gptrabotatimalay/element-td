/**
 * Настройки и рекорды в браузере.
 *
 * Всё обёрнуто в try: в приватном режиме Safari обращение к хранилищу кидает
 * исключение, и из-за сохранения настроек игра падать не должна.
 */

import type { Difficulty, MatchLength } from "../core/types";

const SETTINGS_KEY = "element-td:settings";
const RECORDS_KEY = "element-td:records";
const MAX_RECORDS = 20;

export interface Settings {
  difficulty?: Difficulty;
  length?: MatchLength;
  mapId?: string;
}

export interface RecordEntry {
  waves: number;
  difficulty: Difficulty;
  length: MatchLength;
  mapId: string;
  won: boolean;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Молча: несохранённая настройка не повод ломать партию.
  }
}

const SEEN_HELP_KEY = "element-td:seen-help";

/** Показывали ли уже правила. Новичок не должен искать их сам. */
export function hasSeenHelp(): boolean {
  return read<boolean>(SEEN_HELP_KEY, false);
}

export function markHelpSeen(): void {
  write(SEEN_HELP_KEY, true);
}

export function loadSettings(): Settings {
  return read<Settings>(SETTINGS_KEY, {});
}

export function saveSettings(settings: Settings): void {
  write(SETTINGS_KEY, { ...loadSettings(), ...settings });
}

/** Рекорды отсортированы по числу волн, лучший первый. */
export function loadRecords(): RecordEntry[] {
  return read<RecordEntry[]>(RECORDS_KEY, []);
}

export function saveRecord(entry: RecordEntry): void {
  const records = [...loadRecords(), entry]
    .sort((a, b) => b.waves - a.waves)
    .slice(0, MAX_RECORDS);
  write(RECORDS_KEY, records);
}
