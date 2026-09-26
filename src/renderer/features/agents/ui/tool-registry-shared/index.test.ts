import { describe, expect, it } from 'vitest';
import {
  formatFlowIdForSubtitle,
  getNumberValue,
  getStringValue,
  isSubagentTaskPart,
  partLifecycleState,
  reRootAtProjectDir,
} from './index';

/**
 * The safe readers every tool card uses to pull values off an arbitrary tool input. Tool input is
 * whatever the provider sent, so the contract that matters is that a wrong-typed or absent value
 * yields a harmless default rather than leaking `undefined` into a card's title.
 */
describe('tool input value readers', () => {
  it('returns the value only when it is the expected type', () => {
    expect(getStringValue({ a: 'x' }, 'a')).toBe('x');
    expect(getStringValue({ a: 42 }, 'a')).toBe('');
    expect(getNumberValue({ a: 42 }, 'a')).toBe(42);
    expect(getNumberValue({ a: '42' }, 'a')).toBe(0);
  });

  it('defaults rather than throwing on a missing key or absent input', () => {
    expect(getStringValue(undefined, 'a')).toBe('');
    expect(getStringValue({}, 'missing')).toBe('');
    expect(getNumberValue(undefined, 'a')).toBe(0);
    expect(getNumberValue({}, 'missing')).toBe(0);
  });

  it('preserves numeric edge values a truthiness check would swallow', () => {
    // 0 and negatives are real readings, not "absent" — a card showing "0 lines" must not say "".
    expect(getNumberValue({ a: 0 }, 'a')).toBe(0);
    expect(getNumberValue({ a: -1 }, 'a')).toBe(-1);
    expect(getNumberValue({ a: Number.MAX_SAFE_INTEGER }, 'a')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('truncates a long flow id and leaves a short one intact', () => {
    expect(formatFlowIdForSubtitle('')).toBe('');
    expect(formatFlowIdForSubtitle('abc')).toBe('abc');
    expect(formatFlowIdForSubtitle('12345678')).toBe('12345678');
    expect(formatFlowIdForSubtitle('123456789')).toBe('12345678…');
  });
});

/**
 * Extracted from two tool cards that had drifted into duplicate copies of this scan, so a
 * regression here silently changes how BOTH the registry's generic card and the Edit card display
 * paths. The contract is deliberately narrow: it answers only "re-root this, or don't", and each
 * caller owns its own fallback.
 */
describe('reRootAtProjectDir', () => {
  it('re-roots an absolute path at the first recognised project directory', () => {
    expect(reRootAtProjectDir('/Users/me/code/proj/src/main/index.ts')).toBe('src/main/index.ts');
    expect(reRootAtProjectDir('/home/me/repo/packages/api/server.ts')).toBe(
      'packages/api/server.ts',
    );
    expect(reRootAtProjectDir('/a/b/components/Button.tsx')).toBe('components/Button.tsx');
  });

  it('re-roots at the FIRST indicator when a path contains several', () => {
    // Order matters: re-rooting at the last one would hide which package the file belongs to.
    expect(reRootAtProjectDir('/repo/packages/ui/src/lib/index.ts')).toBe(
      'packages/ui/src/lib/index.ts',
    );
  });

  it('returns null when there is nothing to re-root at, so callers apply their own fallback', () => {
    expect(reRootAtProjectDir('/Users/me/notes/todo.txt')).toBeNull();
    expect(reRootAtProjectDir('/')).toBeNull();
    expect(reRootAtProjectDir('')).toBeNull();
  });

  it('leaves relative paths alone — they are already short', () => {
    expect(reRootAtProjectDir('src/main/index.ts')).toBeNull();
    expect(reRootAtProjectDir('./src/index.ts')).toBeNull();
  });

  it('declines Windows paths rather than mangling them', () => {
    // Frink ships on Windows, where paths are drive-rooted and backslash-separated. This scan is
    // POSIX-shaped by design; it must return null so the caller shows the path unchanged, rather
    // than splitting on a separator that is not there and returning something wrong.
    expect(reRootAtProjectDir('C:\\Users\\me\\proj\\src\\main\\index.ts')).toBeNull();
    expect(reRootAtProjectDir('C:/Users/me/proj/src/main/index.ts')).toBeNull();
  });

  it('does not re-root when the indicator is the whole leading segment', () => {
    // rootIndex must be > 0: an absolute path splits to a leading '', so index 0 is never a real
    // directory. Guards a "simplification" that drops the bound and returns the untouched path.
    expect(reRootAtProjectDir('/src')).toBe('src');
    expect(reRootAtProjectDir('/src/index.ts')).toBe('src/index.ts');
  });
});

describe('isSubagentTaskPart', () => {
  it('matches Task and Agent by type or toolName', () => {
    expect(isSubagentTaskPart({ type: 'tool-Task' })).toBe(true);
    expect(isSubagentTaskPart({ type: 'tool-Agent' })).toBe(true);
    expect(isSubagentTaskPart({ type: 'tool-x', toolName: 'Task' })).toBe(true);
    expect(isSubagentTaskPart({ type: 'tool-x', toolName: 'Agent' })).toBe(true);
  });

  it('ignores unrelated tools (incl. work-queue TaskCreate)', () => {
    expect(isSubagentTaskPart({ type: 'tool-Bash' })).toBe(false);
    expect(isSubagentTaskPart({ type: 'tool-TaskCreate' })).toBe(false);
    expect(isSubagentTaskPart({ type: 'text' })).toBe(false);
  });
});

describe('partLifecycleState', () => {
  it('prefers a top-level state', () => {
    expect(partLifecycleState({ type: 'tool-Bash', state: 'output-available' })).toBe(
      'output-available',
    );
  });

  it("falls back to a data part's own state", () => {
    expect(partLifecycleState({ type: 'data-compact', data: { state: 'output-error' } })).toBe(
      'output-error',
    );
  });

  it('reports nothing when neither carries one', () => {
    expect(partLifecycleState({ type: 'text' })).toBeUndefined();
    expect(partLifecycleState({ type: 'data-compact', data: {} })).toBeUndefined();
  });
});
