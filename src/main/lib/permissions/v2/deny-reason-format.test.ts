import { describe, expect, it } from 'vitest';
import { formatDenyReason } from './deny-reason-format';
import type { DenyReason } from './types';

describe('formatDenyReason', () => {
  it.each<[DenyReason, RegExp]>([
    [{ kind: 'rule:deny', rule: 'Bash(rm:*)', tier: 'user' }, /user.*Bash\(rm:\*\)/],
    [{ kind: 'rule:deny', rule: 'Edit(src/**)', tier: 'project' }, /project.*Edit\(src\/\*\*\)/],
    [{ kind: 'safety:path', path: '/etc/.env' }, /\/etc\/\.env/],
    [
      { kind: 'safety:write-path', path: '/home/u/.zshrc' },
      /startup.*\/home\/u\/\.zshrc.*yourself/,
    ],
    [{ kind: 'db:unavailable' }, /database/i],
  ])('formats %j', (reason, pattern) => {
    expect(formatDenyReason(reason)).toMatch(pattern);
  });

  it('every kind produces a non-empty string', () => {
    const cases: DenyReason[] = [
      { kind: 'rule:deny', rule: 'X', tier: 'policy' },
      { kind: 'safety:path', path: '/p' },
      { kind: 'safety:write-path', path: '/p' },
      { kind: 'db:unavailable' },
    ];
    for (const c of cases) {
      const msg = formatDenyReason(c);
      expect(typeof msg).toBe('string');
      expect(msg.length).toBeGreaterThan(0);
    }
  });
});
