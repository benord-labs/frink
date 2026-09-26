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
 * This helper rewrites those into a runnable shape at the moment the SDK
 * payload is built — never persisted to disk. Stays alongside the existing
 * per-session rewrites in `executor.ts` (API_KEY arg filter, `z_` SDK-order
 * prefix, npm registry override).
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
  const parsed: ParseEntry[] = parse(input);
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

export function normalizeSpawnShape(
  rawCommand: string,
  rawArgs: readonly string[],
  cwd?: string,
): NormalizedSpawnShape {
  const rewrites: SpawnShapeRewrite[] = [];
  // Trim leading/trailing whitespace before any whitespace-detection check.
  // Without this, copy-paste artifacts like `"npx "` defeat the npx
  // auto-yes equality check (`command === 'npx'` is false) and leave the
  // MCP unable to spawn under no-TTY stdio.
  let command = rawCommand.trim();
  let args: string[] = [...rawArgs];

  // Both branches face the same ambiguity — a string with spaces is either a
  // whole shell line or a single path living under a directory with a space.
  // `isExistingPath` is the tie-breaker; only a string that resolves to no file
  // gets tokenized.
  if (WHITESPACE_PATTERN.test(command) && args.length === 0) {
    // Shell line (`npx -y @railway/mcp-server`) vs. self-executing script
    // (`/Users/me/My Projects/mcp/dist/server.js` with a shebang, empty args).
    if (!isExistingPath(command, cwd)) {
      const tokens = parseShellTokens(command);
      if (tokens && tokens.length > 1) {
        command = tokens[0];
        args = tokens.slice(1);
        rewrites.push('command-split');
      }
    }
  } else if (args.length === 1 && WHITESPACE_PATTERN.test(args[0])) {
    // Smushed args (`["-y firecrawl-mcp"]`) vs. interpreter script
    // (`node "/path with spaces/foo.js"`).
    if (!isExistingPath(args[0], cwd)) {
      const tokens = parseShellTokens(args[0]);
      if (tokens && tokens.length > 1) {
        args = tokens;
        rewrites.push('args-split');
      }
    }
  }

  if ((command === 'npx' || command.endsWith('/npx')) && args[0] !== '-y' && args[0] !== '--yes') {
    args = ['-y', ...args];
    rewrites.push('npx-auto-yes');
  }

  return { command, args, rewrites };
}
