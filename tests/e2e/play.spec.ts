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
    const canvas = document.querySelector<HTMLCanvasElement>(".board canvas");
    if (!canvas) return false;
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const distinct = new Set<string>();
    // Шаг выборки — простое число пикселей, а не круглая сотня.
    // При круглом шаге и ширине холста, кратной ему (например 1500 точек на
    // экране с тройной плотностью), проба всегда попадает в одну и ту же
    // колонку: получается муар, и полностью нарисованное поле выглядит
    // как заливка четырьмя цветами.
    for (let i = 0; i < data.length; i += 4 * 997) {
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


/**
 * Экранная точка центра клетки поля.
 *
 * Повторяет расчёт из FieldRenderer, включая поворот: на узком экране поле
 * рисуется развёрнутым на четверть оборота, и координаты без этого не сходятся.
 */
async function cellPoint(
  page: Page,
  col: number,
  row: number,
): Promise<{ x: number; y: number }> {
  return page.evaluate(
    (cell: { col: number; row: number }) => {
      const canvas = document.querySelector<HTMLCanvasElement>(".board canvas")!;
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.max(1, Math.min(3, Math.floor(window.devicePixelRatio || 1)));
      const straight = Math.min(canvas.width / 960, canvas.height / 640);
      const turned = Math.min(canvas.width / 640, canvas.height / 960);
      const rotated = turned > straight;
      const scale = rotated ? turned : straight;
      const fieldW = rotated ? 640 : 960;
      const fieldH = rotated ? 960 : 640;
      const offsetX = (canvas.width - fieldW * scale) / 2;
      const offsetY = (canvas.height - fieldH * scale) / 2;
      const fx = cell.col * 64 + 32;
      const fy = cell.row * 64 + 32;
      const sx = rotated ? offsetX + (640 - fy) * scale : offsetX + fx * scale;
      const sy = rotated ? offsetY + fx * scale : offsetY + fy * scale;
      return { x: rect.left + sx / dpr, y: rect.top + sy / dpr };
    },
    { col, row },
  );
}

async function startSolo(page: Page): Promise<void> {
  await page.goto("/");
  await dismissHelp(page);
  await page.getByRole("button", { name: "Играть", exact: true }).click();
  await expect(page.locator(".board canvas")).toBeVisible();
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

  const target = await cellPoint(page, 0, 0);
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

  for (const selector of [".hud", ".board canvas", ".towers", ".actions"]) {
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
  await expect(page.locator(".board canvas")).toBeVisible();
  await page.waitForTimeout(600);

  // Панель отправки появляется только в версусе.
  await expect(page.locator(".side")).toContainText("Отправить сопернику");

  const goldBefore = Number(
    (await page.locator(".hud__gold span").last().textContent())!.replace(/\D/g, ""),
  );

  const sendButton = page.locator(".sends .send-btn").first();
  await sendButton.click();
  await page.waitForTimeout(400);

  const goldAfter = Number(
    (await page.locator(".hud__gold span").last().textContent())!.replace(/\D/g, ""),
  );
  expect(goldAfter).toBeLessThan(goldBefore);
});

test("версус: поле соперника всегда видно и его нельзя застроить", async ({ page }) => {
  await page.goto("/");
  await dismissHelp(page);
  await page.getByRole("button", { name: "С ботом Версус против ИИ" }).click();
  await page.getByRole("button", { name: "Играть", exact: true }).click();
  await expect(page.locator(".board canvas")).toBeVisible();
  await page.waitForTimeout(600);

  // Карта соперника всегда на виду — переключаться, чтобы её увидеть, не нужно.
  await expect(page.locator(".rival__canvas")).toBeVisible();

  // По ней можно кликнуть, чтобы поменять поля местами.
  await page.locator(".rival__canvas").click();
  await expect(page.locator(".rival__stats")).toContainText("Твоё поле");

  // Пока в основном окне чужое поле, панель башен заблокирована целиком.
  await expect
    .poll(() => page.locator(".tower-btn[data-element]:disabled").count(), {
      timeout: 5000,
    })
    .toBe(6);

  await page.locator(".rival__canvas").click();
  await expect(page.locator(".rival__stats")).toContainText("Поле соперника");
});

test("холст совпадает с местом, которое занимает на экране", async ({ page }) => {
  // Панели снизу меняют высоту уже после первого замера холста — в версусе
  // к ним добавляется ряд кнопок отправки. Если холст об этом не узнает,
  // картинка рисуется в одном масштабе, а клики считаются в другом, и игрок
  // промахивается мимо площадок.
  await page.goto("/");
  await dismissHelp(page);
  await page.getByRole("button", { name: "С ботом Версус против ИИ" }).click();
  await page.getByRole("button", { name: "Играть", exact: true }).click();
  await expect(page.locator(".board canvas")).toBeVisible();

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const canvas =
            document.querySelector<HTMLCanvasElement>(".board canvas")!;
          const rect = canvas.getBoundingClientRect();
          const dpr = Math.max(1, Math.min(3, Math.floor(window.devicePixelRatio || 1)));
          return (
            Math.abs(canvas.width - Math.round(rect.width * dpr)) +
            Math.abs(canvas.height - Math.round(rect.height * dpr))
          );
        }),
      { timeout: 10_000 },
    )
    .toBeLessThanOrEqual(2);
});

test("улучшение башни сразу видно в панели", async ({ page }) => {
  // Команда применяется на следующем шаге симуляции. Пока панель не следила
  // за состоянием башни, нажатие «Улучшить» выглядело так, будто ничего
  // не произошло: ни списанного золота, ни нового уровня.
  await startSolo(page);
  await page.waitForTimeout(600);


  await page.locator('.tower-btn[data-element="fire"]').click();
  const point = await cellPoint(page, 0, 0);
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(400);

  await page.mouse.click(point.x, point.y);
  await expect(page.locator(".inspect__head")).toContainText("уровень 1");

  // Ускоряем время, чтобы накопить на улучшение.
  await page.locator('.hud__btn[title*="Скорость"]').click();
  const upgrade = page.getByRole("button", { name: /Улучшить/ });
  await expect(upgrade).toBeEnabled({ timeout: 40_000 });
  await upgrade.click();

  await expect(page.locator(".inspect__head")).toContainText("уровень 2", {
    timeout: 10_000,
  });
});
