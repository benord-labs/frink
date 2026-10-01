import { spawn } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { lowerChildPriority } from './lower-child-priority';

describe.skipIf(process.platform === 'win32')('lowerChildPriority', () => {
  it('runs the child below normal priority', async () => {
    const child = spawn('sleep', ['5']);
    try {
      lowerChildPriority(child.pid);
      expect(os.getPriority(child.pid)).toBe(os.constants.priority.PRIORITY_BELOW_NORMAL);
    } finally {
      child.kill();
    }
  });

  it('ignores a child that has already exited', async () => {
    const child = spawn('true');
    await once(child, 'exit');
    expect(() => lowerChildPriority(child.pid)).not.toThrow();
  });

  it('ignores a child that never started', () => {
    expect(() => lowerChildPriority(undefined)).not.toThrow();
  });
});
