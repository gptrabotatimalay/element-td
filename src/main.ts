import "./ui/styles.css";

import { App } from "./ui/app";

const root = document.getElementById("app");
if (!root) throw new Error("Не найден контейнер приложения");

new App(root).showMenu();
