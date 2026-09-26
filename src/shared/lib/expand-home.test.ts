import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandHomePath } from './expand-home';

describe('expandHomePath', () => {
  it('expands a bare ~', () => {
    expect(expandHomePath('~')).toBe(os.homedir());
  });

  it('expands ~/ (POSIX display paths)', () => {
    expect(expandHomePath('~/.claude/agents/x.md')).toBe(
      path.join(os.homedir(), '.claude/agents/x.md'),
    );
  });

  it('expands ~\\ (Windows display paths — built with the OS separator)', () => {
    expect(expandHomePath('~\\.claude\\agents\\x.md')).toBe(
      path.join(os.homedir(), '.claude\\agents\\x.md'),
    );
  });

  it('leaves a non-tilde path unchanged', () => {
    expect(expandHomePath('/etc/hosts')).toBe('/etc/hosts');
    expect(expandHomePath('~not-home/x')).toBe('~not-home/x');
  });
});
