import { defineConfig, devices } from "@playwright/test";

/**
 * Браузерные проверки. Гоняются после каждого слоя сборки.
 *
 * Три устройства неспроста: игра обязана работать и на ноутбуке, и на телефоне
 * в обеих ориентациях. Проверять это глазами по одному разу — гарантированный
 * способ узнать о проблеме от игроков, а не от тестов.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  reporter: [["list"]],
  timeout: 60_000,
  // Сетевые тесты зависят от локального сервера комнат: под общей нагрузкой
  // он иногда не успевает подняться, и тест получает отказ соединения.
  // Одна повторная попытка отделяет это от настоящих поломок.
  retries: 1,
  use: {
    baseURL: "http://localhost:5173",
    trace: "off",
    screenshot: "off",
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
      },
    },
    // На телефонах проверяем только интерфейс и управление. Сетевые тесты
    // от размера экрана не зависят, а вот три набора браузеров, одновременно
    // создающих комнаты на одном сервере, дают гонку и ложные падения.
    {
      name: "phone-portrait",
      testIgnore: /network\.spec\.ts/,
      use: { ...devices["iPhone 13"] },
    },
    {
      name: "phone-landscape",
      testIgnore: /network\.spec\.ts/,
      use: { ...devices["iPhone 13 landscape"] },
    },
  ],
  // Два сервера: Vite для обычных проверок и wrangler для сетевых.
  // Сеть тестируется против собранной версии, потому что именно её и
  // публикуют — проверять сборку отдельно от того, что уедет в прод, смысла нет.
  webServer: [
    {
      command: "npx vite --port 5173",
      url: "http://localhost:5173",
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: "npx vite build && npx wrangler dev --port 8787",
      url: "http://localhost:8787",
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});
