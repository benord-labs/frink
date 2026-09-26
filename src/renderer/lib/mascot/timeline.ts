/**
 * Cancellable async steps for the summon choreography. A sequence checks its
 * token after every await, so leaving the summoning phase stops it cleanly.
 */

export type CancelToken = { cancelled: boolean };

export class SequenceCancelled extends Error {
  constructor() {
    super('Summon sequence cancelled');
  }
}

export function assertLive(token: CancelToken) {
  if (token.cancelled) throw new SequenceCancelled();
}

export function wait(ms: number, token: CancelToken): Promise<void> {
  return new Promise((resolve, reject) => {
    setTimeout(() => (token.cancelled ? reject(new SequenceCancelled()) : resolve()), ms);
  });
}

/** Calls `step` with progress 0→1 once per animation frame over `ms`. */
export function tween(ms: number, token: CancelToken, step: (p: number) => void): Promise<void> {
  assertLive(token);
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const frame = (now: number) => {
      if (token.cancelled) return reject(new SequenceCancelled());
      const p = Math.min(1, (now - start) / ms);
      step(p);
      if (p < 1) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });
}

export function easeOut(t: number): number {
  return 1 - (1 - t) ** 3;
}
