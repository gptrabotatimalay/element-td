/** Мелкие помощники для сборки разметки — чтобы не разводить фреймворк. */

type Attrs = Record<string, string | number | boolean | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    node.append(
      typeof child === "string" ? document.createTextNode(child) : child,
    );
  }
  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Короткое всплывающее сообщение. Само исчезает, кликам не мешает. */
export function toast(message: string): void {
  const existing = document.querySelector(".toast");
  if (existing) existing.remove();
  const node = el("div", { class: "toast", text: message });
  document.body.append(node);
  window.setTimeout(() => node.remove(), 1700);
}

export function formatNumber(value: number): string {
  const rounded = Math.round(value);
  // Тысячи разделяем узким пробелом: в поздних волнах золото шестизначное.
  return rounded.toLocaleString("ru-RU").replace(/ /g, " ");
}
