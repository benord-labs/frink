type ExponentialBackoffOptions = {
  baseMs: number;
  maxMs: number;
  jitterMaxMs: number;
  exponentOffset?: number;
  randomFn?: () => number;
};

export function computeExponentialBackoffMs(
  consecutiveFailures: number,
  options: ExponentialBackoffOptions,
): number {
  const { baseMs, maxMs, jitterMaxMs, exponentOffset = 0, randomFn = Math.random } = options;
  const exponent = Math.max(consecutiveFailures + exponentOffset, 0);
  const exponentialBackoffMs = Math.min(maxMs, baseMs * 2 ** exponent);
  const jitterMs = Math.floor(randomFn() * jitterMaxMs);
  return exponentialBackoffMs + jitterMs;
}
