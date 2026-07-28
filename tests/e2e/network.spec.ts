import { expect, test, type Page } from "@playwright/test";

/**
 * Сетевая игра проверяется двумя браузерами одновременно — иначе проверять
 * нечего: половина ошибок сети видна только тогда, когда с обеих сторон
 * реальные клиенты.
 *
 * Тесты идут против собранной версии на wrangler (порт 8787), а не против
 * Vite: там же живёт сервер комнат, и это ровно та сборка, которая уедет
 * на публичный адрес.
 */

const APP = "http://localhost:8787";

/** Закрывает правила, которые игра показывает новичку при первом заходе. */
async function dismissHelp(page: Page): Promise<void> {
  const button = page.getByRole("button", { name: "Понятно" });
  if (await button.isVisible().catch(() => false)) await button.click();
}

/** Хост создаёт комнату и возвращает код. */
async function hostCreatesRoom(
  page: Page,
  mode: "Версус" | "Кооп",
): Promise<string> {
  await page.goto(APP);
  await dismissHelp(page);
  const modeName =
    mode === "Версус" ? "Версус Против брата по сети" : "Кооп Вместе по сети";
  await page.getByRole("button", { name: modeName }).click();
  await page.getByRole("button", { name: "Играть", exact: true }).click();
  await page.getByRole("button", { name: "Создать комнату" }).click();

  const heading = page.locator(".panel h2");
  await expect(heading).toContainText("Комната", { timeout: 15_000 });
  const code = (await heading.textContent())!.replace("Комната", "").trim();
  expect(code).toMatch(/^[A-HJ-NP-Z]{4}$/);
  return code;
}

async function guestJoins(
  page: Page,
  mode: "Версус" | "Кооп",
  code: string,
): Promise<void> {
  await page.goto(APP);
  await dismissHelp(page);
  const modeName =
    mode === "Версус" ? "Версус Против брата по сети" : "Кооп Вместе по сети";
  await page.getByRole("button", { name: modeName }).click();
  await page.getByRole("button", { name: "Играть", exact: true }).click();
  await page.locator('input[placeholder="КОД"]').fill(code);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.locator(".panel h2")).toContainText(`Комната ${code}`, {
    timeout: 15_000,
  });
}

test.describe("сетевая игра", () => {
  // По одному за раз: несколько пар браузеров, одновременно поднимающих
  // комнаты на локальном сервере, роняют его — и падения выглядят как
  // проблемы игры, хотя это перегруженная среда проверки.
  test.describe.configure({ mode: "serial" });

  test("двое заходят в комнату по коду и видят друг друга", async ({
    browser,
  }) => {
    const hostCtx = await browser.newContext();
    const guestCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const guest = await guestCtx.newPage();

    try {
      const code = await hostCreatesRoom(host, "Версус");
      await guestJoins(guest, "Версус", code);

      // У хоста должна появиться активная кнопка старта — значит второго видно.
      await expect(
        host.getByRole("button", { name: "Начать партию" }),
      ).toBeEnabled({
        timeout: 15_000,
      });
      await expect(host.locator(".panel")).toContainText("игроков: 2 из 2");
    } finally {
      await hostCtx.close();
      await guestCtx.close();
    }
  });

  test("партия стартует у обоих и состояние совпадает", async ({ browser }) => {
    const hostCtx = await browser.newContext();
    const guestCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const guest = await guestCtx.newPage();

    try {
      const code = await hostCreatesRoom(host, "Версус");
      await guestJoins(guest, "Версус", code);

      await host.getByRole("button", { name: "Начать партию" }).click();

      // Поле должно появиться у обоих, а не только у того, кто нажал.
      await expect(host.locator(".board canvas")).toBeVisible({
        timeout: 15_000,
      });
      await expect(guest.locator(".board canvas")).toBeVisible({
        timeout: 15_000,
      });

      await host.waitForTimeout(3000);

      // Номер волны у хоста и гостя должен сойтись: гость рисует то,
      // что посчитал хост, а не свою отдельную партию.
      const hostWave = await host
        .locator(".hud__wave span")
        .last()
        .textContent();
      const guestWave = await guest
        .locator(".hud__wave span")
        .last()
        .textContent();
      expect(guestWave).toBe(hostWave);
    } finally {
      await hostCtx.close();
      await guestCtx.close();
    }
  });

  test("башня гостя появляется у хоста — команды доходят по сети", async ({
    browser,
  }) => {
    const hostCtx = await browser.newContext();
    const guestCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const guest = await guestCtx.newPage();

    try {
      const code = await hostCreatesRoom(host, "Кооп");
      await guestJoins(guest, "Кооп", code);
      await host.getByRole("button", { name: "Начать партию" }).click();
      await expect(guest.locator(".board canvas")).toBeVisible({
        timeout: 15_000,
      });
      await guest.waitForTimeout(1200);

      const goldBefore = Number(
        (await host.locator(".hud__gold span").last().textContent())!.replace(
          /\D/g,
          "",
        ),
      );

      // Гость ставит башню. В коопе поле общее, значит золото спишется у обоих.
      await guest.locator('.tower-btn[data-element="fire"]').click();
      const point = await guest.evaluate(() => {
        const canvas =
          document.querySelector<HTMLCanvasElement>(".board canvas")!;
        const rect = canvas.getBoundingClientRect();
        const dpr = Math.max(1, Math.min(3, Math.floor(window.devicePixelRatio || 1)));
        const scale = Math.min(
          (rect.width * dpr) / 960,
          (rect.height * dpr) / 640,
        );
        const offsetX = (rect.width * dpr - 960 * scale) / 2;
        const offsetY = (rect.height * dpr - 640 * scale) / 2;
        return {
          x: rect.left + (32 * scale + offsetX) / dpr,
          y: rect.top + (32 * scale + offsetY) / dpr,
        };
      });
      await guest.mouse.click(point.x, point.y);

      await expect
        .poll(
          async () =>
            Number(
              (await host
                .locator(".hud__gold span")
                .last()
                .textContent())!.replace(/\D/g, ""),
            ),
          { timeout: 10_000 },
        )
        .toBeLessThan(goldBefore);
    } finally {
      await hostCtx.close();
      await guestCtx.close();
    }
  });

  test("уход хоста не оставляет гостя в подвешенном состоянии", async ({
    browser,
  }) => {
    const hostCtx = await browser.newContext();
    const guestCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const guest = await guestCtx.newPage();

    try {
      const code = await hostCreatesRoom(host, "Версус");
      await guestJoins(guest, "Версус", code);
      await host.getByRole("button", { name: "Начать партию" }).click();
      await expect(guest.locator(".board canvas")).toBeVisible({
        timeout: 15_000,
      });

      await hostCtx.close();

      // Гость должен получить внятное сообщение, а не молча смотреть
      // в замерший экран. Формулировка зависит от того, что сработало
      // раньше — уход хоста, опустевшая комната или потеря связи.
      await expect(guest.locator(".panel")).toContainText(
        /Хост вышел|Соперник вышел|Связь потеряна|Не получилось/,
        { timeout: 25_000 },
      );
    } finally {
      await guestCtx.close();
    }
  });
});
