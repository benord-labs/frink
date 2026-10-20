// bun scripts/qa/smoke-check.ts <main.log> <agents.db> — the checks smoke.sh runs against a booted rig.
// Prints one line per failed check and exits 1 (a crash is one line too), or exits 0 when all pass.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { connectPage, sleep } from './bench/cdp.mjs';
import { FIXTURE_ACCOUNT_ID } from './fixtures/base';
import { CODEX_FIXTURE } from './fixtures/codex';

export const FIXTURE_ACCOUNTS = [FIXTURE_ACCOUNT_ID, CODEX_FIXTURE.accountId];
const COMPOSER_PROBE = `Boolean(document.querySelector('[role="textbox"][contenteditable="true"]'))`;
// The page is still coming up; any other connect error (a dev-server renderer, say) is a verdict.
const STILL_BOOTING =
  /has not loaded a renderer|no page target|fetch failed|ECONNREFUSED|Unable to connect/;

const AccountRowSchema = z.object({ id: z.string(), needs_reauth_at: z.number().nullable() });
export type AccountRow = z.infer<typeof AccountRowSchema>;
/** Validates claude_code_credentials rows where they enter, instead of trusting the query. */
export const AccountRows = z.array(AccountRowSchema);

/** The page as the smoke check uses it: a yes/no probe, and close. */
interface Page {
  probe: (expression: string) => Promise<boolean>;
  close: () => void;
}

export interface WakeResult {
  ok: boolean;
  output: string;
}

/** Narrows a CDP page to the probe the checks need: true only for a literal true. */
export function smokePage(page: Awaited<ReturnType<typeof connectPage>>): Page {
  return {
    probe: async (expression) => (await page.evaluate(expression)) === true,
    close: () => page.close(),
  };
}

export interface SmokeDeps {
  connect: () => Promise<Page>;
  booting: () => boolean;
  wake: () => WakeResult;
  readAccounts: () => AccountRow[];
  readMainLog: () => string | null;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/** Every failed check, as one readable line each; empty when the rig is healthy. */
export function smokeFailures(state: {
  accounts: AccountRow[];
  mainLog: string | null;
  hasComposer: boolean;
}): string[] {
  const failures: string[] = [];
  for (const id of FIXTURE_ACCOUNTS) {
    const row = state.accounts.find((account) => account.id === id);
    if (!row) failures.push(`fixture account ${id} is missing from agents.db`);
    else if (row.needs_reauth_at !== null)
      failures.push(`fixture account ${id} is flagged needs_reauth_at`);
  }
  const flagged = state.mainLog?.split('\n').find((line) => line.includes('needs reauth'));
  if (state.mainLog === null) failures.push('main.log was not written');
  else if (flagged) failures.push(`main.log: ${flagged.trim()}`);
  if (!state.hasComposer) failures.push('no chat composer on screen');
  return failures;
}

/** Connects once the renderer has loaded; a wrong renderer, or boot.sh exiting, fails at once. */
export async function waitForPage(deps: SmokeDeps, timeoutMs: number): Promise<Page> {
  const deadline = deps.now() + timeoutMs;
  for (;;) {
    try {
      return await deps.connect();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!STILL_BOOTING.test(message)) throw error;
      if (!deps.booting())
        throw new Error('boot.sh exited before the app window loaded (see boot.log)');
      if (deps.now() > deadline)
        throw new Error(`the app window did not load within ${timeoutMs / 1000} s`);
      await deps.sleep(1000);
    }
  }
}

async function pollTrue(page: Page, expression: string, deps: SmokeDeps, timeoutMs: number) {
  const deadline = deps.now() + timeoutMs;
  while (deps.now() <= deadline) {
    if (await page.probe(expression)) return true;
    await deps.sleep(1000);
  }
  return false;
}

export const WAKE_TIMEOUT_MS = 60_000;

type Spawn = (
  command: string[],
  options: { timeout: number },
) => {
  exitCode: number | null;
  exitedDueToTimeout?: boolean;
  signalCode?: string | null;
  stdout: { toString(): string };
  stderr: { toString(): string };
};

/** Runs wake-background-chats.ts with a deadline, since it waits for the renderer without one. */
export function wakeFixtureChats(spawn: Spawn): WakeResult {
  const script = join(import.meta.dirname, 'wake-background-chats.ts');
  const run = spawn(['bun', script], { timeout: WAKE_TIMEOUT_MS });
  if (run.exitCode === null) {
    const cause = run.exitedDueToTimeout
      ? `timed out after ${WAKE_TIMEOUT_MS / 1000} s`
      : `killed by ${run.signalCode}`;
    return { ok: false, output: cause };
  }
  return { ok: run.exitCode === 0, output: `${run.stdout}${run.stderr}` };
}

/** Boot to verdict: the renderer is this checkout's bundle, the fixtures wake, then every check. */
export async function runSmoke(deps: SmokeDeps): Promise<string[]> {
  let page: Page;
  try {
    page = await waitForPage(deps, 90_000);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  try {
    const woken = deps.wake();
    if (!woken.ok)
      return [`wake-background-chats.ts failed: ${woken.output.trim().split('\n').pop()}`];
    // Waking resolves the fixture logins; give a flag the app writes for that a moment to land.
    await deps.sleep(3000);
    const hasComposer = await pollTrue(page, COMPOSER_PROBE, deps, 30_000);
    return smokeFailures({
      accounts: deps.readAccounts(),
      mainLog: deps.readMainLog(),
      hasComposer,
    });
  } finally {
    page.close();
  }
}

if (import.meta.main) {
  const [mainLogPath, dbPath] = process.argv.slice(2);
  const bootPid = Number(process.env.QA_BOOT_PID);
  const { Database } = await import('bun:sqlite');
  const failures = await runSmoke({
    connect: async () => smokePage(await connectPage()),
    booting: () => {
      try {
        return process.kill(bootPid, 0);
      } catch {
        return false;
      }
    },
    wake: () => wakeFixtureChats((command, options) => Bun.spawnSync(command, options)),
    readAccounts: () => {
      const db = new Database(dbPath, { readonly: true });
      try {
        return AccountRows.parse(
          db.query('select id, needs_reauth_at from claude_code_credentials').all(),
        );
      } finally {
        db.close();
      }
    },
    readMainLog: () => (existsSync(mainLogPath) ? readFileSync(mainLogPath, 'utf8') : null),
    sleep,
    now: Date.now,
  }).catch((error) => {
    console.log(`smoke-check crashed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
  for (const failure of failures) console.log(failure);
  process.exit(failures.length === 0 ? 0 : 1);
}
