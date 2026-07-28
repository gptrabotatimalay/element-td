/**
 * Звук синтезируется на лету — ни одного файла.
 *
 * Так игра грузится мгновенно, ничего не может не догрузиться, и вся звуковая
 * палитра правится числами здесь же. Браузеры не дают запускать звук до первого
 * действия пользователя, поэтому контекст создаётся лениво, при первом касании.
 */

type Waveform = OscillatorType;

/** Окно прореживания выстрелов и сколько их в нём допускается. */
const SHOT_WINDOW_SECONDS = 0.12;
const MAX_SHOTS_PER_WINDOW = 3;

interface ToneOptions {
  freq: number;
  /** Конечная частота — для съезжающих вниз или вверх звуков. */
  freqEnd?: number;
  duration: number;
  type?: Waveform;
  volume?: number;
  /** Задержка перед началом, в секундах. */
  delay?: number;
}

class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicTimer: number | null = null;
  private musicStep = 0;

  enabled = true;
  musicEnabled = true;

  /**
   * Ограничитель на выстрелы.
   *
   * К середине партии на поле три десятка башен, и каждая стреляет примерно
   * раз в секунду. Если озвучивать все, получается сплошной треск, в котором
   * не слышно ни утечки жизни, ни прихода босса — а это ровно то, ради чего
   * звук в игре и нужен. Поэтому подряд идущие выстрелы прореживаются.
   */
  private lastShotAt = 0;
  private shotsInWindow = 0;

  /** Создаётся при первом действии игрока — раньше браузер всё равно не даст. */
  private ensure(): AudioContext | null {
    if (!this.enabled) return null;
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return this.ctx;
    }
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      // Общая громкость. Была 0.35, и вместе с тихими отдельными звуками
      // выстрел звучал на трёх сотых от максимума — формально играл, а на
      // слух его просто не было.
      this.master.gain.value = 0.8;
      this.master.connect(this.ctx.destination);
      return this.ctx;
    } catch {
      // Звук — не повод ронять игру.
      this.enabled = false;
      return null;
    }
  }

  private tone(options: ToneOptions): void {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;

    const start = ctx.currentTime + (options.delay ?? 0);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = options.type ?? "square";
    osc.frequency.setValueAtTime(options.freq, start);
    if (options.freqEnd !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(1, options.freqEnd),
        start + options.duration,
      );
    }

    const volume = options.volume ?? 0.3;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(volume, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + options.duration);

    osc.connect(gain);
    gain.connect(this.master);
    osc.start(start);
    osc.stop(start + options.duration + 0.02);
  }

  /** Шум — для взрывов и попаданий. */
  private noise(duration: number, volume: number, filterFreq: number): void {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;

    const frames = Math.floor(ctx.sampleRate * duration);
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) {
      // Затухание внутри самого буфера — дешевле, чем отдельная огибающая.
      data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = filterFreq;
    const gain = ctx.createGain();
    gain.gain.value = volume;

    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    source.start();
  }

  // ── Игровые события ────────────────────────────────────────────────────────

  shoot(element: string): void {
    const ctx = this.ensure();
    if (!ctx) return;

    const now = ctx.currentTime;
    if (now - this.lastShotAt > SHOT_WINDOW_SECONDS) {
      this.lastShotAt = now;
      this.shotsInWindow = 0;
    }
    if (this.shotsInWindow >= MAX_SHOTS_PER_WINDOW) return;
    this.shotsInWindow++;

    switch (element) {
      case "fire":
        this.tone({
          freq: 320,
          freqEnd: 120,
          duration: 0.09,
          type: "sawtooth",
          volume: 0.24,
        });
        break;
      case "ice":
        this.tone({
          freq: 880,
          freqEnd: 1320,
          duration: 0.08,
          type: "sine",
          volume: 0.216,
        });
        break;
      case "lightning":
        this.tone({
          freq: 1400,
          freqEnd: 400,
          duration: 0.07,
          type: "square",
          volume: 0.192,
        });
        break;
      case "earth":
        this.tone({
          freq: 140,
          freqEnd: 60,
          duration: 0.14,
          type: "triangle",
          volume: 0.336,
        });
        break;
      case "poison":
        this.tone({
          freq: 240,
          freqEnd: 180,
          duration: 0.1,
          type: "triangle",
          volume: 0.192,
        });
        break;
    }
  }

  explosion(): void {
    this.noise(0.24, 0.5, 900);
    this.tone({
      freq: 90,
      freqEnd: 40,
      duration: 0.2,
      type: "triangle",
      volume: 0.384,
    });
  }

  build(): void {
    this.tone({ freq: 330, duration: 0.08, type: "square", volume: 0.5 });
    this.tone({
      freq: 494,
      duration: 0.09,
      type: "square",
      volume: 0.384,
      delay: 0.06,
    });
    this.tone({
      freq: 659,
      duration: 0.12,
      type: "square",
      volume: 0.336,
      delay: 0.13,
    });
  }

  upgrade(): void {
    this.tone({ freq: 523, duration: 0.08, type: "square", volume: 0.5 });
    this.tone({
      freq: 784,
      duration: 0.07,
      type: "square",
      volume: 0.36,
      delay: 0.06,
    });
    this.tone({
      freq: 1047,
      duration: 0.14,
      type: "square",
      volume: 0.336,
      delay: 0.12,
    });
  }

  sell(): void {
    this.tone({
      freq: 520,
      freqEnd: 200,
      duration: 0.16,
      type: "triangle",
      volume: 0.336,
    });
  }

  denied(): void {
    this.tone({
      freq: 160,
      freqEnd: 110,
      duration: 0.12,
      type: "square",
      volume: 0.288,
    });
  }

  /** Утечка монстра — должно быть неприятно и заметно даже боковым слухом. */
  leak(): void {
    this.tone({
      freq: 220,
      freqEnd: 90,
      duration: 0.35,
      type: "sawtooth",
      volume: 0.5,
    });
    this.noise(0.22, 0.3, 500);
  }

  waveStart(): void {
    this.tone({ freq: 196, duration: 0.18, type: "sawtooth", volume: 0.5 });
    this.tone({
      freq: 294,
      duration: 0.22,
      type: "sawtooth",
      volume: 0.288,
      delay: 0.14,
    });
  }

  bossWarning(): void {
    this.tone({ freq: 110, duration: 0.42, type: "sawtooth", volume: 0.5 });
    this.tone({
      freq: 82,
      duration: 0.5,
      type: "sawtooth",
      volume: 0.48,
      delay: 0.35,
    });
  }

  victory(): void {
    const notes = [523, 659, 784, 1047];
    notes.forEach((freq, i) => {
      this.tone({
        freq,
        duration: 0.26,
        type: "square",
        volume: 0.432,
        delay: i * 0.13,
      });
    });
  }

  defeat(): void {
    const notes = [392, 330, 262, 196];
    notes.forEach((freq, i) => {
      this.tone({
        freq,
        duration: 0.34,
        type: "triangle",
        volume: 0.48,
        delay: i * 0.19,
      });
    });
  }

  heal(): void {
    this.tone({
      freq: 660,
      freqEnd: 990,
      duration: 0.18,
      type: "sine",
      volume: 0.384,
    });
  }

  send(): void {
    this.tone({
      freq: 200,
      freqEnd: 420,
      duration: 0.14,
      type: "sawtooth",
      volume: 0.336,
    });
  }

  // ── Музыка ────────────────────────────────────────────────────────────────

  /**
   * Фоновая партия: медленный минорный ход в басу. Намеренно скупая —
   * зацикленная мелодия за двадцать минут партии утомляет сильнее тишины.
   */
  startMusic(): void {
    if (this.musicTimer !== null || !this.musicEnabled) return;
    const bass = [110, 110, 98, 87, 110, 110, 131, 98];

    const play = (): void => {
      if (!this.musicEnabled) return;
      const note = bass[this.musicStep % bass.length]!;
      this.tone({ freq: note, duration: 0.7, type: "triangle", volume: 0.12 });
      if (this.musicStep % 4 === 0) {
        this.tone({
          freq: note * 3,
          duration: 0.5,
          type: "sine",
          volume: 0.06,
          delay: 0.25,
        });
      }
      this.musicStep++;
    };

    play();
    this.musicTimer = window.setInterval(play, 900);
  }

  stopMusic(): void {
    if (this.musicTimer !== null) {
      window.clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
  }

  toggleSound(on: boolean): void {
    this.enabled = on;
    if (!on) this.stopMusic();
  }

  toggleMusic(on: boolean): void {
    this.musicEnabled = on;
    if (on) this.startMusic();
    else this.stopMusic();
  }
}

export const sound = new SoundEngine();
