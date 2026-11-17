import { Semaphore } from 'async-mutex';
import { AGENT_RUNTIMES, type AgentRuntime } from '../../../shared/lib/ai-providers';

/**
 * Per-runtime concurrency gate, acquired after credential resolution so the runtime is known.
 * Caps are env-overridable and currently wide open while the queued-state UX is redesigned.
 */

const DEFAULT_CONCURRENCY = 1024;

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const gateEntries = AGENT_RUNTIMES.map((runtime) => {
  const cap = readPositiveInt(`FRINK_CONCURRENCY_${runtime.toUpperCase()}`, DEFAULT_CONCURRENCY);
  return [runtime, { cap, semaphore: new Semaphore(cap) }];
});
// SAFETY: built from every entry of AGENT_RUNTIMES, so each runtime has a gate.
const gates = Object.fromEntries(gateEntries) as Record<
  AgentRuntime,
  { cap: number; semaphore: Semaphore }
>;

export function getRuntimeCap(runtime: AgentRuntime): number {
  return gates[runtime].cap;
}

/** Acquire a runtime-specific slot. Returns an idempotent release function. */
export async function acquireRuntimeSlot(runtime: AgentRuntime): Promise<() => void> {
  const [, releaseRaw] = await gates[runtime].semaphore.acquire(1);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseRaw();
  };
}
