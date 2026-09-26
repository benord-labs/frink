/**
 * Git-integration test guard. Some sandbox runners (e.g. the Cursor agent) block
 * `.git/hooks` creation with EPERM even with an empty template, so git-integration
 * suites must skip there. Computed once at import; gate a suite with
 * `describe.skipIf(!canInitGit)`.
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const canInitGit = (() => {
  const probeDir = mkdtempSync(join(tmpdir(), 'frink-git-probe-'));
  try {
    execSync('git init -b main', {
      cwd: probeDir,
      stdio: 'pipe',
      env: { ...process.env, GIT_TEMPLATE_DIR: '' },
    });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
})();
