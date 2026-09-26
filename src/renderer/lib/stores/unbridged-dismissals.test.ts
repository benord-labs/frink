import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dismissForever, isDismissed, snooze, snoozeOrEscalate } from './unbridged-dismissals';

const P = 'proj-a';
const T = 'cursor';
const SKILL = 'agent-memory';
const KEY = 'unbridged-dismissals';
const WEEK = 7 * 24 * 60 * 60 * 1000;

function fakeStorage() {
  let store: Record<string, string> = {};
  return {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      store = {};
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeStorage());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('unbridged-dismissals', () => {
  it('an unseen skill is not dismissed', () => {
    expect(isDismissed(P, T, SKILL)).toBe(false);
  });

  it('snoozes a skill now but frees it again once the window passes', () => {
    vi.useFakeTimers();
    snoozeOrEscalate(P, T, [SKILL]);
    expect(isDismissed(P, T, SKILL)).toBe(true);
    vi.advanceTimersByTime(WEEK + 1);
    expect(isDismissed(P, T, SKILL)).toBe(false);
  });

  it('makes a skill permanent on the third active dismiss (survives the snooze window)', () => {
    vi.useFakeTimers();
    snoozeOrEscalate(P, T, [SKILL]);
    snoozeOrEscalate(P, T, [SKILL]);
    snoozeOrEscalate(P, T, [SKILL]);
    vi.advanceTimersByTime(WEEK * 52);
    expect(isDismissed(P, T, SKILL)).toBe(true);
  });

  it('an ignored toast (auto-close) snoozes but never escalates to permanent', () => {
    vi.useFakeTimers();
    // Many ignored toasts in a row must keep re-prompting after each window, never go permanent.
    for (let i = 0; i < 5; i++) {
      snooze(P, T, [SKILL]);
      expect(isDismissed(P, T, SKILL)).toBe(true);
      vi.advanceTimersByTime(WEEK + 1);
      expect(isDismissed(P, T, SKILL)).toBe(false);
    }
  });

  it('snooze never downgrades a permanent dismissal', () => {
    dismissForever(P, T, [SKILL]);
    snooze(P, T, [SKILL]);
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    expect(stored[`${P}:${T}:${SKILL}`].until).toBe('forever');
  });

  it('makes a skill permanent immediately on an explicit dismiss', () => {
    vi.useFakeTimers();
    dismissForever(P, T, [SKILL]);
    vi.advanceTimersByTime(WEEK * 52);
    expect(isDismissed(P, T, SKILL)).toBe(true);
  });

  it('never downgrades a permanent dismissal back to a snooze', () => {
    dismissForever(P, T, [SKILL]);
    snoozeOrEscalate(P, T, [SKILL]);
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    expect(stored[`${P}:${T}:${SKILL}`].until).toBe('forever');
  });

  it('keys per project, tool and skill independently', () => {
    dismissForever(P, T, [SKILL]);
    expect(isDismissed('proj-b', T, SKILL)).toBe(false);
    expect(isDismissed(P, 'claude-code', SKILL)).toBe(false);
    expect(isDismissed(P, T, 'other-skill')).toBe(false);
  });

  it('treats corrupt storage as no dismissals', () => {
    localStorage.setItem(KEY, '{not valid json');
    expect(isDismissed(P, T, SKILL)).toBe(false);
  });

  it('expires strictly at the window edge (uses > not >=)', () => {
    vi.useFakeTimers();
    snooze(P, T, [SKILL]);
    vi.advanceTimersByTime(WEEK - 1);
    expect(isDismissed(P, T, SKILL)).toBe(true);
    vi.advanceTimersByTime(1); // now exactly at `until`
    expect(isDismissed(P, T, SKILL)).toBe(false);
  });

  it('treats a malformed stored entry as not dismissed (schema drift, fail-open)', () => {
    localStorage.setItem(KEY, JSON.stringify({ [`${P}:${T}:${SKILL}`]: { foo: 'bar' } }));
    expect(isDismissed(P, T, SKILL)).toBe(false);
  });

  it('never crashes when storage holds a JSON primitive instead of an object', () => {
    // A stray/tampered/old-shape value ('42', 'null') must fail open, not throw out of a toast callback.
    localStorage.setItem(KEY, '42');
    expect(isDismissed(P, T, SKILL)).toBe(false); // primitive → fail open
    expect(() => snooze(P, T, [SKILL])).not.toThrow(); // write path doesn't crash on a primitive
    localStorage.setItem(KEY, 'null');
    expect(isDismissed(P, T, SKILL)).toBe(false);
    expect(() => snoozeOrEscalate(P, T, [SKILL])).not.toThrow();
  });

  it('swallows a failed write (quota/denied) instead of throwing out of the callback', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
      removeItem: () => {},
    });
    expect(() => snoozeOrEscalate(P, T, [SKILL])).not.toThrow();
  });
});
