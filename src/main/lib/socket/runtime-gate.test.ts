import { describe, expect, it } from 'vitest';
import { acquireRuntimeSlot, getRuntimeCap } from './runtime-gate';

describe('runtime-gate', () => {
  it('exposes per-runtime cap via getRuntimeCap', () => {
    expect(getRuntimeCap('codex')).toBeGreaterThan(0);
    expect(getRuntimeCap('claude')).toBeGreaterThan(0);
  });

  it('acquires and releases a codex slot (out-of-process app-server runtime)', async () => {
    const release = await acquireRuntimeSlot('codex');
    expect(release).toBeTypeOf('function');
    release();
    // Slot is free again for a fresh codex acquirer.
    const fresh = await acquireRuntimeSlot('codex');
    fresh();
  });
});
