/** A running agent command's latest output on either provider: a display-only pull that never
 * decides liveness (Claude's Stop hook snapshot and Codex's item lifecycle do). */

import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { CommandOutputTail } from '../../../../shared/types/wake-hold/command-output';
import { getCodexLiveTurn } from '../../agent-runner/codex/codex-live-turn';
import { readWakeHolds } from '../claude-wake-hold';
import type { ClaudeSession } from '../claude-session-registry';

/** Roughly the last hundred lines of ordinary output, bounded however much the command wrote. */
const TAIL_BYTES = 8192;
/** The alphabet the CLI names sessions and tasks with; anything else could step out of its dir. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** The project folder each session's files were found under, so a poll lists the root once. */
const projectBySession = new WeakMap<ClaudeSession, string>();
/** When each task's file was last looked for in vain: a missing file costs one search per pause. */
const missesBySession = new WeakMap<ClaudeSession, Map<string, number>>();
const MISS_RETRY_MS = 10_000;

/**
 * Null unless `commandId` is still running: a shell a Claude chat's wait is on (its harness task id),
 * or a command of a Codex chat's live turn (its item id). Nothing else has output to watch.
 */
export async function readCommandOutput(
  subChatId: string,
  commandId: string,
): Promise<CommandOutputTail | null> {
  const codex = getCodexLiveTurn(subChatId)?.commandOutputs.get(commandId);
  if (codex) {
    return {
      runningForMs: Date.now() - codex.startedAt,
      text: cleanOutputTail(codex.text, codex.cut),
    };
  }
  const session = sessionWaitingOnShell(subChatId, commandId);
  if (!session) return null;
  const tail = await readClaudeTaskOutput(session, commandId);
  // The shell may have ended during the read; a finished command is never reported as running.
  if (sessionWaitingOnShell(subChatId, commandId) !== session) return null;
  return tail ?? { runningForMs: null, text: null };
}

/** The Claude session whose wait is still on the shell `taskId`, if there is one. */
function sessionWaitingOnShell(subChatId: string, taskId: string): ClaudeSession | null {
  const session = readWakeHolds().get(subChatId)?.session;
  const task = session?.stopHook?.lastPendingWork?.backgroundTasks.find((t) => t.id === taskId);
  return session && task?.type === 'shell' ? session : null;
}

/** The CLI's own output file, `<tmp>/claude-<uid>/<project>/<session>/tasks/<task>.output` (decision
 * unattended-wake-budget, 2026-10-02). The project dir encodes the CLI's cwd, so it is listed. */
async function readClaudeTaskOutput(
  session: ClaudeSession,
  taskId: string,
): Promise<CommandOutputTail | null> {
  if (!SAFE_ID.test(session.sdkSessionId) || !SAFE_ID.test(taskId)) return null;
  const misses = missesBySession.get(session) ?? new Map<string, number>();
  missesBySession.set(session, misses);
  if (Date.now() - (misses.get(taskId) ?? 0) < MISS_RETRY_MS) return null;
  const root = claudeTempRoot();
  const known = projectBySession.get(session);
  const projects = known ? [known] : await readdir(root).catch(() => []);
  const found = await findTaskTail(root, projects, session.sdkSessionId, taskId);
  // Only this task waits out a miss: its file may not exist yet, and its siblings' files do.
  if (!found) {
    misses.set(taskId, Date.now());
    return null;
  }
  misses.delete(taskId);
  projectBySession.set(session, found.project);
  return found.tail;
}

/** Claude's per-user temp root, holding every project's task output. */
function claudeTempRoot(): string {
  return join(process.env.CLAUDE_CODE_TMPDIR || '/tmp', `claude-${process.getuid?.() ?? 0}`);
}

/** The first of `projects` holding this task's output, with its tail. */
async function findTaskTail(
  root: string,
  projects: string[],
  sessionId: string,
  taskId: string,
): Promise<{ project: string; tail: CommandOutputTail } | null> {
  for (const project of projects) {
    const tail = await readFileTail(join(root, project, sessionId, 'tasks', `${taskId}.output`));
    if (tail) return { project, tail };
  }
  return null;
}

/** Null when the path is missing, a symlink, or not a regular file: the running command can write
 * into its own tasks dir, so a link there must not turn this into a read of another file. */
async function readFileTail(path: string): Promise<CommandOutputTail | null> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!file) return null;
  try {
    const stat = await file.stat();
    if (!stat.isFile()) return null;
    const length = Math.min(stat.size, TAIL_BYTES);
    const { buffer } = await file.read(Buffer.alloc(length), 0, length, stat.size - length);
    return {
      // Some filesystems report no birth time, as 0.
      runningForMs: stat.birthtimeMs > 0 ? Date.now() - stat.birthtimeMs : null,
      text: cleanOutputTail(buffer.toString('utf8'), length < stat.size),
    };
  } finally {
    await file.close();
  }
}

/** Output as it reads on screen: control codes gone, a `\r`-redrawn line at its last state, and a
 * cut tail's partial first line dropped. */
export function cleanOutputTail(raw: string, cut: boolean): string {
  if (raw.includes('\0')) return 'Binary output';
  const newline = raw.indexOf('\n');
  // With no line break left in a cut tail it is all one long line: mark the cut rather than drop it.
  const text = !cut ? raw : newline === -1 ? `…${raw.slice(1)}` : raw.slice(newline + 1);
  return stripVTControlCharacters(text)
    .split('\n')
    .map((line) => line.replace(/\r$/, '').split('\r').at(-1))
    .join('\n')
    .trimEnd();
}
