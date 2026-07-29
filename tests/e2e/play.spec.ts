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
      const canvas =
        document.querySelector<HTMLCanvasElement>(".board canvas")!;
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
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

  // Сама панель тоже не должна разъезжаться в ширину: на лежачем телефоне ряд
  // из шести кнопок башен в неё не влезал, и крайняя обрезалась краем.
  const sideOverflow = await page
    .locator(".side")
    .evaluate((node) => node.scrollWidth - node.clientWidth);
  expect(sideOverflow).toBeLessThanOrEqual(1);
});

test("версус с ботом: отправка монстров сопернику работает", async ({
  page,
}) => {
  await page.goto("/");
  await dismissHelp(page);
  await page.getByRole("button", { name: "С ботом Версус против ИИ" }).click();
  await page.getByRole("button", { name: "Играть", exact: true }).click();
  await expect(page.locator(".board canvas")).toBeVisible();
  await page.waitForTimeout(600);

  // Панель отправки появляется только в версусе.
  await expect(page.locator(".side")).toContainText("Отправить сопернику");

  const goldBefore = Number(
    (await page.locator(".hud__gold span").last().textContent())!.replace(
      /\D/g,
      "",
    ),
  );

  const sendButton = page.locator(".sends .send-btn").first();
  await sendButton.click();
  await page.waitForTimeout(400);

  const goldAfter = Number(
    (await page.locator(".hud__gold span").last().textContent())!.replace(
      /\D/g,
      "",
    ),
  );
  expect(goldAfter).toBeLessThan(goldBefore);
});

test("версус: поле соперника всегда видно и его нельзя застроить", async ({
  page,
}) => {
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

test("холст совпадает с местом, которое занимает на экране", async ({
  page,
}) => {
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
          const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
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

test("клик по полю работает после того, как мышь отпустили вне холста", async ({
  page,
}) => {
  // Указатель захватывается на время нажатия. Без захвата отпускание за
  // пределами холста до него не доходило: поле оставалось «занятым», и
  // следующий клик по нему пропадал.
  await startSolo(page);
  await page.waitForTimeout(500);

  const point = await cellPoint(page, 0, 0);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();

  // Уводим курсор на боковую панель и отпускаем уже там.
  const side = (await page.locator(".side").boundingBox())!;
  await page.mouse.move(side.x + side.width / 2, side.y + 40);
  await page.mouse.up();

  const goldBefore = Number(
    (await page.locator(".hud__gold span").last().textContent())!.replace(
      /\D/g,
      "",
    ),
  );

  await page.locator('.tower-btn[data-element="fire"]').click();
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(400);

  const goldAfter = Number(
    (await page.locator(".hud__gold span").last().textContent())!.replace(
      /\D/g,
      "",
    ),
  );
  expect(goldAfter).toBeLessThan(goldBefore);
});

test("выход из партии спрашивает подтверждение", async ({ page }) => {
  // Кнопка выхода стоит рядом со звуком и убивает партию без возврата: ни
  // сохранений, ни рекорда, а в сетевой партии обрывается и у соперника.
  await startSolo(page);
  await page.waitForTimeout(300);

  await page.locator(".hud__btn--exit").click();
  await expect(page.locator(".overlay h2")).toHaveText("Выйти в меню?");
  // Поле на месте: пока не подтвердили, партия продолжается.
  await expect(page.locator(".board canvas")).toBeVisible();

  await page.getByRole("button", { name: "Остаться" }).click();
  await expect(page.locator(".overlay")).toHaveCount(0);
  await expect(page.locator(".board canvas")).toBeVisible();

  await page.locator(".hud__btn--exit").click();
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  await expect(page.locator(".menu__title")).toBeVisible();
});

test("кнопки в шапке не меньше пальца, а выход отодвинут от остальных", async ({
  page,
}) => {
  await startSolo(page);
  await page.waitForTimeout(300);

  const boxes = await page.locator(".hud__btn").evaluateAll((nodes) =>
    nodes
      .filter((node) => (node as HTMLElement).offsetParent !== null)
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return { x: rect.x, right: rect.right, w: rect.width, h: rect.height };
      }),
  );
  expect(boxes.length).toBeGreaterThan(1);
  for (const box of boxes) {
    expect(box.w).toBeGreaterThanOrEqual(44);
    expect(box.h).toBeGreaterThanOrEqual(44);
  }

  // Промах пальцем мимо соседней кнопки должен уходить в пустоту, а не в выход.
  const last = boxes[boxes.length - 1]!;
  const before = boxes[boxes.length - 2]!;
  expect(last.x - before.right).toBeGreaterThanOrEqual(10);
});

test("выключенный звук остаётся выключенным во второй партии", async ({
  page,
}) => {
  // Движок звука один на страницу и переживает выход в меню. Кнопка рисовалась
  // с жёстким «🔊», и первое нажатие во второй партии включало звук вместо
  // выключения, не меняя значка.
  await startSolo(page);
  const soundBtn = page.locator('.hud__btn[title="Звук"]');
  await expect(soundBtn).toHaveText("🔊");
  await soundBtn.click();
  await expect(soundBtn).toHaveText("🔇");

  await page.locator(".hud__btn--exit").click();
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  await page.getByRole("button", { name: "Играть", exact: true }).click();
  await expect(page.locator(".board canvas")).toBeVisible();

  await expect(page.locator('.hud__btn[title="Звук"]')).toHaveText("🔇");
});

test("Tab в соло не съедается и ходит по кнопкам панели", async ({
  page,
  isMobile,
}) => {
  // Tab переключает поля в версусе, но в соло поле одно, и перехват просто
  // отнимал у панели навигацию с клавиатуры.
  //
  // Проверяем только на ноутбуке: в мобильной эмуляции Chromium обход по Tab
  // не работает сам по себе, и проверять там нечего.
  test.skip(!!isMobile, "навигация по фокусу — про клавиатуру");
  await startSolo(page);
  await page.waitForTimeout(300);

  await page.locator('.hud__btn[title="Звук"]').focus();
  const focused = new Set<string>();
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Tab");
    focused.add(
      await page.evaluate(
        () =>
          `${document.activeElement?.className ?? ""}|${
            document.activeElement?.textContent ?? ""
          }`,
      ),
    );
  }
  expect(focused.size).toBeGreaterThan(1);
});

test("счётчик нанесённого урона растёт, пока панель открыта", async ({
  page,
}) => {
  // Показатель не входит в слепок панели (иначе она мигала бы на каждый
  // выстрел), поэтому обновляется отдельным узлом. Пока этого не было, число
  // стояло на значении момента открытия.
  await startSolo(page);
  await page.waitForTimeout(400);

  await page.locator('.tower-btn[data-element="fire"]').click();
  const point = await cellPoint(page, 0, 0);
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(300);
  await page.mouse.click(point.x, point.y);
  await expect(page.locator(".inspect__stats")).toContainText("Нанесено");

  const damage = page
    .locator(".inspect__stats span", { hasText: "Нанесено" })
    .locator("b");
  await page.locator('.hud__btn[title*="Скорость"]').click();

  // Панель не трогаем вообще: число обязано вырасти само.
  await expect
    .poll(
      async () => Number((await damage.textContent())!.replace(/\D/g, "")),
      {
        timeout: 60_000,
      },
    )
    .toBeGreaterThan(0);
});

test("кнопка досрочной волны гаснет после призыва и не обещает лишнего", async ({
  page,
}) => {
  // Симуляция принимает призыв не чаще раза в интервал волны. Кнопка об этом
  // не знала: оставалась активной и показывала тост «волна вызвана досрочно»,
  // хотя команду отклоняли.
  await startSolo(page);
  await page.waitForTimeout(400);

  const rush = page.getByRole("button", { name: "Волна раньше" });
  await expect(rush).toBeEnabled();
  await rush.click();

  await expect(rush).toBeDisabled({ timeout: 5000 });
  await expect(page.locator(".hud__next")).not.toContainText("вызвать сейчас");
});
