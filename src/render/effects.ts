/**
 * Короткоживущие вспышки: молнии, взрывы, всплывающее золото.
 *
 * Живут только в рендере и на симуляцию не влияют — иначе одинаковые партии
 * начали бы расходиться из-за анимации. Питаются журналом событий тика.
 */

import type { GameEvent } from "../core/types";
import { ELEMENT_COLORS, PALETTE } from "./palette";

interface ChainEffect {
  kind: "chain";
  points: { x: number; y: number }[];
  life: number;
  maxLife: number;
}

interface BlastEffect {
  kind: "blast";
  x: number;
  y: number;
  radius: number;
  life: number;
  maxLife: number;
}

interface CoinEffect {
  kind: "coin";
  x: number;
  y: number;
  amount: number;
  life: number;
  maxLife: number;
}

type Effect = ChainEffect | BlastEffect | CoinEffect;

/** Секунды жизни эффектов. Короткие: поле и так плотное. */
const CHAIN_LIFE = 0.14;
const BLAST_LIFE = 0.28;
const COIN_LIFE = 0.7;

export class EffectLayer {
  private effects: Effect[] = [];

  /** Разбор журнала событий тика. Крупные награды показываем, мелкие — нет. */
  ingest(events: readonly GameEvent[]): void {
    for (const event of events) {
      switch (event.t) {
        case "chain":
          this.effects.push({
            kind: "chain",
            points: event.points,
            life: CHAIN_LIFE,
            maxLife: CHAIN_LIFE,
          });
          break;
        case "explode":
          this.effects.push({
            kind: "blast",
            x: event.x,
            y: event.y,
            radius: event.radius,
            life: BLAST_LIFE,
            maxLife: BLAST_LIFE,
          });
          break;
        case "kill":
          // Иначе поздние волны превращаются в метель из цифр.
          if (event.bounty >= 25) {
            this.effects.push({
              kind: "coin",
              x: event.x,
              y: event.y,
              amount: event.bounty,
              life: COIN_LIFE,
              maxLife: COIN_LIFE,
            });
          }
          break;
        default:
          break;
      }
    }
  }

  update(dt: number): void {
    let write = 0;
    for (const effect of this.effects) {
      effect.life -= dt;
      if (effect.life > 0) this.effects[write++] = effect;
    }
    this.effects.length = write;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    for (const effect of this.effects) {
      const t = effect.life / effect.maxLife;
      switch (effect.kind) {
        case "chain":
          this.drawChain(ctx, effect, t);
          break;
        case "blast":
          this.drawBlast(ctx, effect, t);
          break;
        case "coin":
          this.drawCoin(ctx, effect, t);
          break;
      }
    }
  }

  private drawChain(
    ctx: CanvasRenderingContext2D,
    effect: ChainEffect,
    t: number,
  ): void {
    if (effect.points.length < 2) return;
    ctx.save();
    ctx.globalAlpha = t;
    ctx.strokeStyle = ELEMENT_COLORS.lightning[3];
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(effect.points[0]!.x, effect.points[0]!.y);
    for (let i = 1; i < effect.points.length; i++) {
      ctx.lineTo(effect.points[i]!.x, effect.points[i]!.y);
    }
    ctx.stroke();
    ctx.strokeStyle = ELEMENT_COLORS.lightning[1];
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  private drawBlast(
    ctx: CanvasRenderingContext2D,
    effect: BlastEffect,
    t: number,
  ): void {
    ctx.save();
    ctx.globalAlpha = t * 0.6;
    ctx.fillStyle = ELEMENT_COLORS.earth[2];
    ctx.beginPath();
    ctx.arc(
      effect.x,
      effect.y,
      effect.radius * (1.2 - t * 0.5),
      0,
      Math.PI * 2,
    );
    ctx.fill();
    ctx.globalAlpha = t;
    ctx.strokeStyle = ELEMENT_COLORS.fire[2];
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  private drawCoin(
    ctx: CanvasRenderingContext2D,
    effect: CoinEffect,
    t: number,
  ): void {
    ctx.save();
    ctx.globalAlpha = Math.min(1, t * 1.6);
    ctx.fillStyle = PALETTE.gold;
    ctx.font = "bold 16px system-ui, sans-serif";
    ctx.textAlign = "center";
    // Всплывает вверх по мере угасания.
    ctx.fillText(`+${effect.amount}`, effect.x, effect.y - (1 - t) * 26);
    ctx.restore();
  }

  clear(): void {
    this.effects.length = 0;
  }
}
