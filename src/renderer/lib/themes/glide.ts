/**
 * Cancels `glide` and returns where the next glide starts: `now()`, read before the cancel, while
 * it still runs, so turning back mid-glide never jumps; otherwise `settled`.
 */
export function cancelGlide<T>(glide: Animation | null, now: () => T, settled: T): T {
  const from = glide?.playState === 'running' ? now() : settled;
  glide?.cancel();
  return from;
}
