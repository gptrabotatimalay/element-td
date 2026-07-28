/**
 * Палитра. Ограниченная намеренно — так пиксель-арт выглядит целым,
 * а не набором случайных картинок.
 */

export const PALETTE = {
  // Земля и дорога
  grassDark: "#1b2a20",
  grass: "#233527",
  grassLight: "#2c422f",
  roadDark: "#5a4a38",
  road: "#6e5b45",
  roadLight: "#836d53",
  roadEdge: "#463a2c",

  // Площадки под башни
  padDark: "#2b3830",
  pad: "#36453a",
  padLight: "#445446",
  padGlow: "#a8e06a",

  // Камень построек
  stoneDark: "#3a3540",
  stone: "#544d5c",
  stoneLight: "#726a7d",

  // Интерфейс
  ink: "#12101a",
  parchment: "#e8dcc0",
  gold: "#f2c14e",
  blood: "#c0392b",
  frame: "#221d2e",
  frameLight: "#3a3350",

  // Монстры
  fleshDark: "#5c2f3a",
  flesh: "#8a4553",
  fleshLight: "#b35f6e",
  boneLight: "#d8cbb0",
  eye: "#ffe9a8",
  eyeAngry: "#ff6b4a",
  armorPlate: "#6b7b8c",
  armorPlateLight: "#93a4b5",
  wing: "#6d5b8a",
  wingLight: "#9b86bd",
  slime: "#7fae4a",
  slimeLight: "#a8d466",
} as const;

/** Цвета стихий: тёмный, основной, светлый, свечение. */
export const ELEMENT_COLORS = {
  fire: ["#8c2f16", "#e04b1f", "#ff8c42", "#ffd08a"],
  ice: ["#1c5a7a", "#2e93c4", "#6fd0f5", "#c4f0ff"],
  lightning: ["#8a6a12", "#e0bb2e", "#ffe066", "#fff6c2"],
  earth: ["#4a3520", "#7d5a33", "#a8814d", "#cfae7c"],
  poison: ["#2f5c1e", "#5a9c32", "#8ddb5a", "#c6f29a"],
  light: ["#8a7328", "#d9be5c", "#fff3b0", "#fffbe6"],
} as const satisfies Record<string, readonly [string, string, string, string]>;
