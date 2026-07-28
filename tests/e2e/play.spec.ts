import { expect, test, type Page } from "@playwright/test";

/**
 * Проверки в живом браузере: игра реально запускается, по полю можно кликать,
 * башни ставятся, волны идут, жизни списываются.
 *
 * Тут намеренно нет проверок баланса — они гоняются в Node тысячами партий.
 * Здесь смотрим ровно то, что видит игрок: рисуется ли что-то, нажимается ли.
 */

/** Считает непрозрачные пиксели холста — пустой чёрный экран так не пройдёт. */
async function canvasHasContent(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".field canvas");
    if (!canvas) return false;
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const distinct = new Set<string>();
    // Каждый сотый пиксель: важно наличие разных цветов, а не заливка одним.
    for (let i = 0; i < data.length; i += 400) {
      distinct.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    }
    return distinct.size > 5;
  });
}


/**
 * Закрывает правила, если они показались.
 *
 * При первом заходе игра сама открывает окно с правилами — так задумано:
 * человек приходит по ссылке от друга и должен понять игру без объяснений.
 * Тест — тоже новый игрок, поэтому проходит через это окно, а не в обход.
 */
async function dismissHelp(page: Page): Promise<void> {
  const button = page.getByRole("button", { name: "Понятно" });
  if (await button.isVisible().catch(() => false)) await button.click();
}

async function startSolo(page: Page): Promise<void> {
  await page.goto("/");
  await dismissHelp(page);
  await page.getByRole("button", { name: "Играть", exact: true }).click();
  await expect(page.locator(".field canvas")).toBeVisible();
}

test("меню открывается и показывает все режимы", async ({ page }) => {
  await page.goto("/");
  await dismissHelp(page);
  await expect(page.locator(".menu__title")).toHaveText("ELEMENT TD");
  // Имена берём целиком: «Версус» встречается и в подписи режима с ботом.
  for (const mode of [
    "Соло Выжить как можно дольше",
    "С ботом Версус против ИИ",
    "Версус Против брата по сети",
    "Кооп Вместе по сети",
  ]) {
    await expect(page.getByRole("button", { name: mode })).toBeVisible();
  }
  for (const difficulty of ["Лёгкая", "Средняя", "Хардкор"]) {
    await expect(
      page.getByRole("button", { name: new RegExp(difficulty) }),
    ).toBeVisible();
  }
});

test("поле рисуется, а не остаётся чёрным", async ({ page }) => {
  await startSolo(page);
  // Опрос вместо фиксированной паузы: под нагрузкой от параллельных тестов
  // первый кадр может задержаться, и жёсткое ожидание давало ложные падения.
  await expect
    .poll(() => canvasHasContent(page), { timeout: 15_000 })
    .toBe(true);
});

test("все шесть башен доступны в панели", async ({ page }) => {
  await startSolo(page);
  const buttons = page.locator(".tower-btn");
  await expect(buttons).toHaveCount(6);
  for (const label of ["Огонь", "Лёд", "Молния", "Земля", "Яд", "Свет"]) {
    await expect(page.locator(`.tower-btn:has-text("${label}")`)).toBeVisible();
  }
});

test("башня ставится по клику и списывает золото", async ({ page }) => {
  await startSolo(page);
  await page.waitForTimeout(400);

  const goldBefore = Number(
    (await page.locator(".hud__gold span").last().textContent())!.replace(
      /\D/g,
      "",
    ),
  );

  await page.locator('.tower-btn[data-element="fire"]').click();

  // Кликаем по центру первой свободной площадки, а не наугад по холсту.
  const target = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".field canvas")!;
    const rect = canvas.getBoundingClientRect();
    // Логика та же, что в игре: поле 960×640 вписано в холст с полями.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const scale = Math.min((rect.width * dpr) / 960, (rect.height * dpr) / 640);
    const offsetX = (rect.width * dpr - 960 * scale) / 2;
    const offsetY = (rect.height * dpr - 640 * scale) / 2;
    // Первая площадка карты «Змейка» — колонка 0, ряд 0 сетки 15×10.
    const cellCenterX = 0 * 64 + 32;
    const cellCenterY = 0 * 64 + 32;
    return {
      x: rect.left + (cellCenterX * scale + offsetX) / dpr,
      y: rect.top + (cellCenterY * scale + offsetY) / dpr,
    };
  });

  await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(300);

  const goldAfter = Number(
    (await page.locator(".hud__gold span").last().textContent())!.replace(
      /\D/g,
      "",
    ),
  );
  expect(goldAfter).toBeLessThan(goldBefore);
});

test("волны идут и время до следующей уменьшается", async ({ page }) => {
  await startSolo(page);
  const next = page.locator(".hud__next");
  await expect(next).toContainText("следующая волна");

  const first = await next.textContent();
  await page.waitForTimeout(2500);
  const second = await next.textContent();
  expect(second).not.toBe(first);
});

test("без башен жизни кончаются и появляется экран итогов", async ({
  page,
}) => {
  await page.goto("/");
  await dismissHelp(page);
  await page.getByRole("button", { name: /Хардкор/ }).click();
  await page.getByRole("button", { name: /Быстрая/ }).click();
  await page.getByRole("button", { name: "Играть", exact: true }).click();

  // Ускоряем до предела и ждём: без единой башни база падает быстро.
  await page.locator('.hud__btn[title*="Скорость"]').click();
  await page.locator('.hud__btn[title*="Скорость"]').click();

  await expect(page.locator(".panel h2")).toHaveText("Поражение", {
    timeout: 50_000,
  });
  await expect(page.locator(".result__stats")).toBeVisible();
});

test("пауза останавливает время", async ({ page }) => {
  await startSolo(page);
  await page.locator('.hud__btn[title*="Пауза"]').click();

  const before = await page.locator(".hud__next").textContent();
  await page.waitForTimeout(1800);
  const after = await page.locator(".hud__next").textContent();
  expect(after).toBe(before);
});

test("подсказка «как играть» открывается и закрывается", async ({ page }) => {
  await page.goto("/");
  await dismissHelp(page);
  await page.getByRole("button", { name: "Как играть" }).click();
  await expect(page.locator(".panel h2")).toHaveText("Как играть");
  await page.getByRole("button", { name: "Понятно" }).click();
  await expect(page.locator(".overlay")).toHaveCount(0);
});

test("в интерфейс помещается всё нужное и ничего не уезжает за экран", async ({
  page,
}) => {
  await startSolo(page);
  await page.waitForTimeout(300);

  // Горизонтальной прокрутки быть не должно ни на одном устройстве.
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  for (const selector of [".hud", ".field canvas", ".towers", ".actions"]) {
    await expect(page.locator(selector)).toBeVisible();
  }

  // Кнопки башен должны оставаться нажимаемыми пальцем.
  const height = await page
    .locator(".tower-btn")
    .first()
    .evaluate((node) => node.getBoundingClientRect().height);
  expect(height).toBeGreaterThanOrEqual(44);
});

test("версус с ботом: отправка монстров сопернику работает", async ({ page }) => {
  await page.goto("/");
  await dismissHelp(page);
  await page.getByRole("button", { name: "С ботом Версус против ИИ" }).click();
  await page.getByRole("button", { name: "Играть", exact: true }).click();
  await expect(page.locator(".field canvas")).toBeVisible();
  await page.waitForTimeout(600);

  // Панель отправки появляется только в версусе.
  await expect(page.locator('.dock:has-text("Отправить сопернику")')).toBeVisible();

  const goldBefore = Number(
    (await page.locator(".hud__gold span").last().textContent())!.replace(/\D/g, ""),
  );

  // Первая кнопка отправки — самый дешёвый монстр.
  const sendButton = page.locator(".towers").nth(0).locator(".tower-btn").first();
  await sendButton.click();
  await page.waitForTimeout(400);

  const goldAfter = Number(
    (await page.locator(".hud__gold span").last().textContent())!.replace(/\D/g, ""),
  );
  expect(goldAfter).toBeLessThan(goldBefore);
});

test("версус: поле соперника можно посмотреть, но не застроить", async ({ page }) => {
  await page.goto("/");
  await dismissHelp(page);
  await page.getByRole("button", { name: "С ботом Версус против ИИ" }).click();
  await page.getByRole("button", { name: "Играть", exact: true }).click();
  await expect(page.locator(".field canvas")).toBeVisible();
  await page.waitForTimeout(600);

  await page.getByRole("button", { name: "Поле соперника" }).click();
  await expect(page.locator(".hud__next")).toContainText("смотрим поле соперника");

  // Пока смотрим чужое поле, панель башен заблокирована целиком.
  const disabled = await page.locator(".tower-btn[data-element]:disabled").count();
  expect(disabled).toBe(6);

  await page.getByRole("button", { name: "Своё поле" }).click();
  await expect(page.locator(".hud__next")).toContainText("следующая волна");
});
