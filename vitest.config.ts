import { defineConfig } from "vitest/config";

/**
 * Быстрые проверки в Node: симуляция и баланс.
 * Браузерные тесты живут в tests/e2e и гоняются Playwright — здесь их не трогаем.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/e2e/**"],
  },
});
