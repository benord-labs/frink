import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

  it('keeps every launcher of the rig bundle local-only, so no run re-mints it against the public relay', () => {
    // Unset resolves Frink's relay in every build, and the re-mint it triggers is written into the
    // shared rig home; a local-only boot afterwards cannot undo it, so both launchers pass blank.
    expect(boot).toContain('FRINK_WEBHOOK_BASE_URL= \\');
    expect(readFileSync(join(qaDir, '../perf/real-app-storm.mjs'), 'utf-8')).toContain(
      "FRINK_WEBHOOK_BASE_URL: ''",
    );
  });

  it('seeds the MCP config into that same rig home, never the operator home', () => {
    expect(read('seed.sh')).toContain('FRINK_HOME="$QA_FRINK_HOME" bun scripts/qa/seed-db.ts');
    expect(read('seed-db.ts')).toContain("resolves to the operator's real home");
  });

  it("puts the app's main log in the run's evidence bundle, and says when it could not", () => {
    expect(boot).toContain('QA_LOG_DIR="${QAVIS_EVIDENCE_DIR:-$QA_USER_DATA/logs}"');
    expect(boot).toContain('FRINK_LOG_DIR="$QA_LOG_DIR"');
    // Announced, so a run that silently fell back cannot pass for one that captured the log.
    expect(boot).toMatch(/echo .*FRINK_LOG_DIR=\$QA_LOG_DIR/);
  });
});
