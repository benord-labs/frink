import { execFileSync } from 'node:child_process';

/** Runs git in `cwd` with a fixed author, so a throwaway repo can commit on any machine. */
export const gitAsTestUser = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    stdio: 'pipe',
  });
