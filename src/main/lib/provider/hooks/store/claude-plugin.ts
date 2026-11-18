import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Settings } from '@anthropic-ai/claude-agent-sdk';
import stableStringify from 'fast-json-stable-stringify';
import { z } from 'zod';
import { frinkUserHome } from '../../../platform/frink-home';

type Hooks = NonNullable<Settings['hooks']>;
/** A plugin's two files, as written. */
type PluginFiles = { manifest: string; hooks: string };

const execFileAsync = promisify(execFile);
const VALIDATE_TIMEOUT_MS = 15_000;
const ValidateReport = z.object({ success: z.boolean() });
/** A failed run that still printed its report. */
const PrintedReport = z.object({ stdout: z.string().min(1) });
/** Per CLI build and plugin folder, this run: whether that CLI loads the plugin. */
const verdicts = new Map<string, Promise<boolean>>();

async function readText(file: string): Promise<string | null> {
  return fs.readFile(file, 'utf8').catch(() => null);
}

/** Whether `folder` is a whole plugin holding exactly `files`. */
async function holds(folder: string, files: PluginFiles): Promise<boolean> {
  const [manifest, hooks] = await Promise.all([
    readText(path.join(folder, '.claude-plugin', 'plugin.json')),
    readText(path.join(folder, 'hooks', 'hooks.json')),
  ]);
  return manifest === files.manifest && hooks === files.hooks;
}

async function stage(folder: string, files: PluginFiles): Promise<void> {
  await fs.mkdir(path.join(folder, '.claude-plugin'), { recursive: true });
  await fs.mkdir(path.join(folder, 'hooks'), { recursive: true });
  await fs.writeFile(path.join(folder, '.claude-plugin', 'plugin.json'), files.manifest, 'utf8');
  await fs.writeFile(path.join(folder, 'hooks', 'hooks.json'), files.hooks, 'utf8');
}

/** Writes `hooks` as a Claude plugin under `~/.frink/hooks/plugins/<digest>` and returns its path:
 * the same hooks reuse one folder, changed hooks get a new one. Throws when it cannot be written. */
export async function writeHooksPlugin(hooks: Hooks): Promise<string> {
  const files = {
    manifest: JSON.stringify({
      name: 'frink-hooks',
      description: "Your hooks, from Frink's copy in ~/.frink/hooks",
    }),
    hooks: stableStringify({ hooks }),
  };
  const digest = createHash('sha256').update(stableStringify(files)).digest('hex').slice(0, 16);
  const folder = path.join(frinkUserHome(), '.frink', 'hooks', 'plugins', digest);
  if (await holds(folder, files)) return folder;
  const staged = `${folder}.${randomUUID()}.tmp`;
  try {
    await stage(staged, files);
    try {
      await fs.rename(staged, folder);
    } catch {
      // Another launch wrote the same plugin first; anything else in the way is a damaged copy.
      if (await holds(folder, files)) return folder;
      await fs.rm(folder, { recursive: true, force: true });
      await fs.rename(staged, folder);
    }
    return folder;
  } finally {
    await fs.rm(staged, { recursive: true, force: true });
  }
}

/** The JSON report of `claude plugin validate`, which also exits 1 for a plugin it refuses. */
async function validateReport(claudeBinary: string, folder: string): Promise<string> {
  const args = ['plugin', 'validate', '--json', folder];
  try {
    return (await execFileAsync(claudeBinary, args, { timeout: VALIDATE_TIMEOUT_MS })).stdout;
  } catch (error) {
    const refused = PrintedReport.safeParse(error);
    if (refused.success) return refused.data.stdout;
    throw error;
  }
}

async function claudeLoads(claudeBinary: string, folder: string): Promise<boolean> {
  const report = await validateReport(claudeBinary, folder);
  return ValidateReport.parse(JSON.parse(report)).success;
}

/** Names one CLI build, so a verdict is never reused for another: a different path, or the same
 * path replaced in place, asks again. */
async function cliBuild(claudeBinary: string): Promise<string> {
  const { mtimeMs, size } = await fs.stat(claudeBinary);
  return `${claudeBinary}\0${mtimeMs}\0${size}`;
}

/** The plugin folder holding `hooks`, or null when the CLI's check refuses it. Only an acceptance
 * is remembered; a refusal, or a check that cannot run (it throws), is asked again. */
export async function claudeHooksPlugin(
  hooks: Hooks,
  claudeBinary: string,
): Promise<string | null> {
  const folder = await writeHooksPlugin(hooks);
  const key = `${await cliBuild(claudeBinary)}\0${folder}`;
  let verdict = verdicts.get(key);
  if (!verdict) {
    verdict = claudeLoads(claudeBinary, folder);
    verdicts.set(key, verdict);
    verdict.then(
      (accepted) => accepted || verdicts.delete(key),
      () => verdicts.delete(key),
    );
  }
  return (await verdict) ? folder : null;
}
