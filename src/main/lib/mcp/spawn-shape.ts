/**
 * Per-session normalization of an MCP's spawn shape.
 *
 * The Frink config stores native MCP entries verbatim from `~/.cursor/mcp.json`
 * and `~/.claude.json`. Native authors frequently produce shapes that the
 * Claude SDK (and Node's `child_process.spawn`) cannot run:
 *  - whole shell line written into `command` with empty `args` (Railway)
 *  - npx invocation without `-y`, which prompts under no-TTY stdio (RunPod)
 *  - args smushed into a single element (`["-y firecrawl-mcp"]`)
 *
 * Rewrites those at spawn time (session payload and `tools-probe/transport.ts`),
 * never on disk: the importer matches native entries by exact command/args.
 *
 * Safety: shell-quote tokenization rejects operators (|, &&, >, env-refs,
 * globs) and returns the input unchanged in those cases — never escalates a
 * pipe into a process spawn.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { type ParseEntry, parse } from 'shell-quote';

type SpawnShapeRewrite = 'command-split' | 'args-split' | 'npx-auto-yes';

export type NormalizedSpawnShape = {
  command: string;
  args: string[];
  rewrites: SpawnShapeRewrite[];
};

/**
 * Tokenize `input` via shell-quote. Returns null if the parser surfaces any
 * non-string token (operator, env-ref, glob) — in that case the caller
 * leaves the input unchanged so we never silently escalate shell features
 * into a spawn.
 */
function parseShellTokens(input: string): string[] | null {
  // win32: `\` is a path separator, not an escape (`C:\tools` → `C:tools`). An object
  // token for `$VAR` trips the bail-out below instead of shell-quote expanding it to ''.
  const source = process.platform === 'win32' ? input.replace(/\\/g, '\\\\') : input;
  const parsed: (ParseEntry | object)[] = parse(source, (key) => ({ envRef: key }));
  const tokens: string[] = [];
  for (const entry of parsed) {
    if (typeof entry === 'string') tokens.push(entry);
    else return null;
  }
  return tokens.length > 0 ? tokens : null;
}

const WHITESPACE_PATTERN = /\s/;

/**
 * True when `raw` names a file that exists — absolute, or relative to `cwd`.
 * Both callers set `cwd` to the session's projectPath, which is also the
 * directory the child actually runs in (`manager.ts` spawn cwd; the SDK CLI's
 * own cwd in `executor.ts`), including when it has been swapped to a chat
 * worktree — so resolution here can never disagree with the spawn.
 *
 * Existence is what separates a shell line from a path that merely contains a
 * space: shell-quote tokenizes on unquoted whitespace and would shred
 * `/Users/me/My Projects/server.js` into three tokens, ENOENT at spawn.
 */
function isExistingPath(raw: string, cwd?: string): boolean {
  const resolved = path.isAbsolute(raw) || !cwd ? raw : path.resolve(cwd, raw);
  return fs.existsSync(resolved);
}

function isNpxCommand(command: string): boolean {
  const base = path.win32.basename(command).toLowerCase();
  return base === 'npx' || base === 'npx.cmd';
}

/** Pin npx to the public registry unless the MCP env names one; shared by session and
 * probe spawns so the Settings probe runs the same invocation a session does. */
export function withNpxRegistryDefault(
  command: string,
  env: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const hasRegistry = Object.keys(env ?? {}).some((k) => k.toLowerCase() === 'npm_config_registry');
  if (!isNpxCommand(command) || hasRegistry) return env;
  return { ...(env ?? {}), npm_config_registry: 'https://registry.npmjs.org/' };
}

async function pathExists(raw: string, cwd?: string): Promise<boolean> {
  const resolved = path.isAbsolute(raw) || !cwd ? raw : path.resolve(cwd, raw);
  return fs.promises.access(resolved).then(
    () => true,
    () => false,
  );
}

export function normalizeSpawnShape(
  rawCommand: string,
  rawArgs: readonly string[],
  cwd?: string,
): NormalizedSpawnShape {
  return normalizeWith(rawCommand, rawArgs, (raw) => isExistingPath(raw, cwd));
}

/** Same rewrite for main-process request paths (probe, tool call): no sync fs on the event loop. */
export async function normalizeSpawnShapeAsync(
  rawCommand: string,
  rawArgs: readonly string[],
  cwd?: string,
): Promise<NormalizedSpawnShape> {
  const candidates = [rawCommand.trim(), ...(rawArgs.length === 1 ? [rawArgs[0]] : [])].filter(
    (candidate) => WHITESPACE_PATTERN.test(candidate),
  );
  const existing = new Set<string>();
  await Promise.all(
    candidates.map(async (candidate) => {
      if (await pathExists(candidate, cwd)) existing.add(candidate);
    }),
  );
  return normalizeWith(rawCommand, rawArgs, (raw) => existing.has(raw));
}

// A string with spaces is a shell line (`npx -y @railway/mcp-server`) or a path under a
// spaced directory (`/Users/me/My Projects/server.js`); only one naming no file is tokenized.
function splitShellLine(raw: string, exists: (raw: string) => boolean): string[] | null {
  if (!WHITESPACE_PATTERN.test(raw) || exists(raw)) return null;
  const tokens = parseShellTokens(raw);
  return tokens && tokens.length > 1 ? tokens : null;
}

function normalizeWith(
  rawCommand: string,
  rawArgs: readonly string[],
  exists: (raw: string) => boolean,
): NormalizedSpawnShape {
  const rewrites: SpawnShapeRewrite[] = [];
  // Trim leading/trailing whitespace before any whitespace-detection check.
  // Without this, copy-paste artifacts like `"npx "` defeat the npx
  // auto-yes equality check (`command === 'npx'` is false) and leave the
  // MCP unable to spawn under no-TTY stdio.
  let command = rawCommand.trim();
  let args: string[] = [...rawArgs];

  const commandTokens = splitShellLine(command, exists);
  if (commandTokens) {
    // Cursor appends `args` to the split line.
    command = commandTokens[0];
    args = [...commandTokens.slice(1), ...args];
    rewrites.push('command-split');
  } else if (args.length === 1) {
    const argTokens = splitShellLine(args[0], exists);
    if (argTokens) {
      args = argTokens;
      rewrites.push('args-split');
    }
  }

  if (isNpxCommand(command) && args[0] !== '-y' && args[0] !== '--yes') {
    args = ['-y', ...args];
    rewrites.push('npx-auto-yes');
  }

  return { command, args, rewrites };
}
