import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

// The rig must never write the operator's Frink state; boot.sh hands the app what enforces it (sc-2903).
const qaDir = join(import.meta.dirname, '.');
const read = (name) => readFileSync(join(qaDir, name), 'utf-8');

describe('QA rig home isolation', () => {
  const boot = read('boot.sh');

  it('launches the app against a rig-owned home under the wiped QA profile', () => {
    expect(read('env.sh')).toContain('QA_FRINK_HOME="$QA_USER_DATA/home"');
    expect(boot).toContain('FRINK_HOME="$QA_FRINK_HOME"');
    // env.sh owns QA_USER_DATA and seed.sh already wipes it, so the rig home resets with no new target.
    expect(read('env.sh')).toContain('QA_USER_DATA=');
    expect(read('seed.sh')).toContain('rm -rf "$QA_USER_DATA"');
  });

  it('keeps the rig local-only, so no run re-mints its bundle against the public relay', () => {
    // Unset resolves Frink's relay in every build, and the re-mint it triggers is written into the
    // shared rig home; a local-only boot afterwards cannot undo it, so the launcher passes blank.
    expect(boot).toContain('FRINK_WEBHOOK_BASE_URL= \\');
  });

  it('seeds the MCP config into that same rig home, never the operator home', () => {
    expect(read('seed.sh')).toContain('FRINK_HOME="$QA_FRINK_HOME" bun scripts/qa/seed-db.ts');
    expect(read('seed-db.ts')).toContain("resolves to the operator's real home");
  });

  it('seeds the Claude account against a marker the seed itself wrote into the rig home', () => {
    // Catches the seed pointing the account at a file it never wrote (or at the operator's own
    // login): each half looks right alone, and the app then swaps the composer for a reconnect card.
    // The space mirrors the real rig home under "Application Support".
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'qa rig seed-')));
    try {
      const home = join(root, 'home');
      // seed.sh creates the rig home before it runs the seed.
      mkdirSync(home);
      const dbPath = join(root, 'data', 'agents.db');
      const seed = spawnSync(
        'bun',
        [join(qaDir, 'seed-db.ts'), '--db', dbPath, '--project-path', root],
        { env: { ...process.env, FRINK_HOME: home }, encoding: 'utf-8' },
      );
      expect(seed.status, seed.stderr).toBe(0);

      const db = new DatabaseSync(dbPath, { readOnly: true });
      const row = db
        .prepare("select source_path from claude_code_credentials where type = 'claude-code'")
        .get();
      db.close();
      const marker = join(home, 'qa-claude-login-marker');
      expect(row.source_path).toBe(`file://${marker}`);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, 'utf-8')).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('boots on the scripted fake claude unless the real one is asked for by name', () => {
    // The seeded account always resolves, so a boot that defaulted to the real CLI would spend the
    // operator's quota on every send.
    expect(boot).toMatch(
      /if \[ "\$\{QA_REAL_CLAUDE:-\}" = "1" \]; then\n\s+bash scripts\/qa\/use-real-claude\.sh\nelse\n\s+bash scripts\/qa\/use-fake-claude\.sh\nfi/,
    );
    expect(boot.indexOf('use-fake-claude.sh')).toBeLessThan(
      boot.indexOf('node_modules/.bin/electron'),
    );
  });

  // The real CLIs are downloaded per checkout, so which outcome applies depends on the machine.
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const realClaude = join(qaDir, '../../resources/bin', `darwin-${arch}`, 'claude');
  const useRealClaude = (appDir) =>
    spawnSync('bash', [join(qaDir, 'use-real-claude.sh'), appDir], { encoding: 'utf-8' });

  const useFakeClaude = (appDir) =>
    spawnSync('bash', [join(qaDir, 'use-fake-claude.sh'), appDir], { encoding: 'utf-8' });
  const fakeClaude = join(qaDir, 'fake-bin', 'darwin-arm64', 'claude');

  it('swaps only claude for the fake, on both Mac arches, and keeps every other bundled CLI real', () => {
    // Catches the fake replacing the whole bundled tree, which strands Codex (it has no PATH
    // fallback), and a fake laid out for one arch only, which leaves an Intel Mac with no claude.
    const appDir = realpathSync(mkdtempSync(join(tmpdir(), 'qa rig app-')));
    try {
      const result = useFakeClaude(appDir);
      expect(result.status, result.stderr).toBe(0);
      for (const hostArch of ['arm64', 'x64']) {
        const dir = join(appDir, 'resources', 'bin', `darwin-${hostArch}`);
        expect(realpathSync(join(dir, 'claude'))).toBe(realpathSync(fakeClaude));
        expect(() => accessSync(join(dir, 'claude'), constants.X_OK)).not.toThrow();
        const realDir = join(qaDir, '../../resources/bin', `darwin-${hostArch}`);
        if (!existsSync(realDir)) continue;
        for (const name of readdirSync(realDir)) {
          if (name === 'claude' || !statSync(join(realDir, name)).isFile()) continue;
          expect(realpathSync(join(dir, name)), name).toBe(realpathSync(join(realDir, name)));
        }
      }
    } finally {
      rmSync(appDir, { recursive: true, force: true });
    }
  });

  it.runIf(existsSync(realClaude))(
    'switches a build that booted on the fake back to a claude it can execute',
    () => {
      // Catches the opt-in unlinking the fake and leaving the build with no claude at all.
      const appDir = realpathSync(mkdtempSync(join(tmpdir(), 'qa rig app-')));
      try {
        expect(useFakeClaude(appDir).status).toBe(0);
        const result = useRealClaude(appDir);
        expect(result.status, result.stderr).toBe(0);
        const linked = join(appDir, 'resources', 'bin', `darwin-${arch}`, 'claude');
        expect(realpathSync(linked)).toBe(realpathSync(realClaude));
        expect(() => accessSync(linked, constants.X_OK)).not.toThrow();
      } finally {
        rmSync(appDir, { recursive: true, force: true });
      }
    },
  );

  it.runIf(!existsSync(realClaude))(
    'refuses the real claude, and leaves the build alone, when the checkout has none',
    () => {
      const appDir = realpathSync(mkdtempSync(join(tmpdir(), 'qa rig app-')));
      try {
        expect(useFakeClaude(appDir).status).toBe(0);
        const result = useRealClaude(appDir);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('no bundled claude');
        expect(realpathSync(join(appDir, 'resources', 'bin', `darwin-${arch}`, 'claude'))).toBe(
          realpathSync(fakeClaude),
        );
      } finally {
        rmSync(appDir, { recursive: true, force: true });
      }
    },
  );

  it("puts the app's main log in the run's evidence bundle, and says when it could not", () => {
    expect(boot).toContain('QA_LOG_DIR="${QAVIS_EVIDENCE_DIR:-$QA_USER_DATA/logs}"');
    expect(boot).toContain('FRINK_LOG_DIR="$QA_LOG_DIR"');
    // Announced, so a run that silently fell back cannot pass for one that captured the log.
    expect(boot).toMatch(/echo .*FRINK_LOG_DIR=\$QA_LOG_DIR/);
  });
});

// An agent shell carries the host's electron-vite dev env; inherited, it silently swaps in the host's code.
describe('QA rig host dev-env isolation', () => {
  const boot = read('boot.sh');
  const build = read('build.sh');
  const scrubCall = /^qa_scrub_host_dev_env$/m;

  it('scrubs the inherited dev env before building, so out-qa is a production bundle', () => {
    expect(build).toContain('. "$(dirname "$0")/scrub-host-env.sh"');
    expect(build.search(scrubCall)).toBeGreaterThan(-1);
    expect(build.search(scrubCall)).toBeLessThan(build.indexOf('bun run build'));
  });

  it("scrubs before exporting the rig's own MAIN_VITE_ port, which the scrub would otherwise drop", () => {
    // The scrub removes every MAIN_VITE_*. Reordered after the export, the bundle would bake the
    // default port and so the operator's real "Frink Dev" userData dir instead of the rig's -21399.
    const exportAt = build.indexOf('export MAIN_VITE_AUTH_SERVER_PORT=21399');
    expect(exportAt).toBeGreaterThan(-1);
    expect(build.search(scrubCall)).toBeLessThan(exportAt);
  });

  it("scrubs before loading the worktree's .env, so .env keys survive and host ones do not", () => {
    expect(boot).toContain('. "$(dirname "$0")/scrub-host-env.sh"');
    const scrubAt = boot.search(scrubCall);
    expect(scrubAt).toBeGreaterThan(-1);
    expect(scrubAt).toBeLessThan(boot.indexOf('if [ -f .env ]'));
    expect(scrubAt).toBeLessThan(boot.indexOf('node_modules/.bin/electron out-qa/main/index.js'));
  });

  it('marks the launch as the rig bundle, so main refuses a leaked dev-server URL', () => {
    expect(boot).toContain('FRINK_QA_BUNDLE=1 \\');
  });

  it('names the same marker the main process checks, and main runs that check at startup', () => {
    // Each side is unit-tested alone; a rename on one side, or a dropped call, would disarm the guard silently.
    const src = (path) => readFileSync(join(qaDir, '../../src/main', path), 'utf-8');
    expect(src('lib/platform/rig-renderer.ts')).toContain('process.env.FRINK_QA_BUNDLE');
    expect(src('index.ts')).toMatch(/^assertRigRendererBundled\(\);$/m);
  });
});
