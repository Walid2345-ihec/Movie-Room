/**
 * Minimal tween scheduler. Tweens advance on a FIXED step (see main.ts) so
 * animation timing is independent of frame rate; the renderer interpolates
 * nothing — it simply reads the latest tweened values.
 */
export type Ease = (t: number) => number;

export const easeOutCubic: Ease = (t) => 1 - Math.pow(1 - t, 3);
export const easeInOutCubic: Ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOutBack: Ease = (t) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

export interface Tween {
  /** Identity key: starting a tween with the same key cancels the previous one. */
  key: string;
  duration: number;
  delay: number;
  ease: Ease;
  onUpdate: (t: number) => void;
  onComplete?: () => void;
  elapsed: number;
  done: boolean;
}

export class TweenManager {
  private readonly tweens = new Map<string, Tween>();

  start(opts: { key: string; duration: number; delay?: number; ease?: Ease; onUpdate: (t: number) => void; onComplete?: () => void }): Tween {
    const t: Tween = { key: opts.key, duration: Math.max(0.0001, opts.duration), delay: opts.delay ?? 0, ease: opts.ease ?? easeOutCubic, onUpdate: opts.onUpdate, onComplete: opts.onComplete, elapsed: 0, done: false };
    this.tweens.set(t.key, t);
    return t;
  }

  cancel(key: string): void {
    this.tweens.delete(key);
  }

  has(key: string): boolean {
    return this.tweens.has(key);
  }

  get active(): number {
    return this.tweens.size;
  }

  /** Advance every tween by `dt` seconds (called from the fixed-step loop). */
  update(dt: number): void {
    for (const [key, tw] of this.tweens) {
      tw.elapsed += dt;
      const local = tw.elapsed - tw.delay;
      if (local < 0) continue;
      const t = Math.min(1, local / tw.duration);
      tw.onUpdate(tw.ease(t));
      if (t >= 1) {
        tw.done = true;
        this.tweens.delete(key);
        tw.onComplete?.();
      }
    }
  }
}
