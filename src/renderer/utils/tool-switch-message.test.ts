// @vitest-environment happy-dom

import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeToolSwitch, notifyToolSwitch } from './tool-switch-message';

vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));
const successMock = vi.mocked(toast.success);

describe('describeToolSwitch (sc-840 at-switch toast copy)', () => {
  it('Codex → Claude says limits are now fully enforced, model resets', () => {
    const out = describeToolSwitch('codex', 'claude-code');
    expect(out?.title).toBe('Now running on Claude');
    expect(out?.description).toContain('fully enforced');
    expect(out?.description).toContain('reset');
  });

  it('→ Codex enforces the gate like Claude (no advisory caveat), model resets', () => {
    const out = describeToolSwitch('claude-code', 'codex');
    expect(out?.title).toBe('Now running on OpenAI');
    expect(out?.description).toContain('came with you');
    expect(out?.description).toContain('fully enforced');
    expect(out?.description).toContain('reset');
  });

  it('a null resolved old type means the default (Claude) — switching to Codex still announces', () => {
    expect(describeToolSwitch(null, 'codex')?.title).toBe('Now running on OpenAI');
  });

  it('same tool → null (no switch toast; caller shows its plain fallback)', () => {
    expect(describeToolSwitch('codex', 'codex')).toBeNull();
    expect(describeToolSwitch('claude-code', 'claude-code')).toBeNull();
  });

  it('missing tool type → null (no crash, no misleading toast)', () => {
    expect(describeToolSwitch(undefined, undefined)).toBeNull();
    expect(describeToolSwitch('codex', undefined)).toBeNull();
  });
});

describe('notifyToolSwitch', () => {
  afterEach(() => successMock.mockClear());

  it('fires the switch toast (title + description) on a real tool change', () => {
    notifyToolSwitch('claude-code', 'codex', 'Default account updated');
    expect(successMock).toHaveBeenCalledWith(
      'Now running on OpenAI',
      expect.objectContaining({ description: expect.stringContaining('came with you') }),
    );
  });

  it('fires the plain fallback when the tool did not change', () => {
    notifyToolSwitch('codex', 'codex', 'Default account updated');
    expect(successMock).toHaveBeenCalledWith('Default account updated');
  });
});
