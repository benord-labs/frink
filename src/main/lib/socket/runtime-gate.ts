import { Semaphore } from 'async-mutex';

/**
 * Per-runtime concurrency gate, acquired after credential resolution so the runtime is known.
 * Caps are env-overridable and currently wide open while the queued-state UX is redesigned.
 */

export type AgentRuntime = 'codex' | 'claude';

const DEFAULT_CODEX_CONCURRENCY = 1024;
const DEFAULT_CLAUDE_CONCURRENCY = 1024;

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const codexCap = readPositiveInt('FRINK_CONCURRENCY_CODEX', DEFAULT_CODEX_CONCURRENCY);
const claudeCap = readPositiveInt('FRINK_CONCURRENCY_CLAUDE', DEFAULT_CLAUDE_CONCURRENCY);

const semaphores: Record<AgentRuntime, Semaphore> = {
  codex: new Semaphore(codexCap),
  claude: new Semaphore(claudeCap),
};

const caps: Record<AgentRuntime, number> = {
  codex: codexCap,
  claude: claudeCap,
};

export function getRuntimeCap(runtime: AgentRuntime): number {
  return caps[runtime];
}

/** Acquire a runtime-specific slot. Returns an idempotent release function. */
export async function acquireRuntimeSlot(runtime: AgentRuntime): Promise<() => void> {
  const [, releaseRaw] = await semaphores[runtime].acquire(1);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseRaw();
  };
}
