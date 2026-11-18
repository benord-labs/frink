// Ends what a Claude CLI's Bash tasks left in other process groups; the CLI kills only the shell's.

import type { ChildProcess } from 'node:child_process';
import log from 'electron-log';
import {
  type ProcessRow,
  readOutputWriters,
  readProcessTable,
  readProcessTableSync,
  readStdoutPaths,
} from './process-table';

/** A process identity a reused pid cannot fake: `pid@start`. */
type MemberKey = string;
/** pgid → the processes seen in it while its task still ran. */
type GroupMembers = Map<number, Set<MemberKey>>;

type TaskLeader = { pid: number; taskId: string; groups: GroupMembers };
type TrackedCli = {
  /** Task shells still running. */
  leaders: Map<MemberKey, TaskLeader>;
  /** Shells seen ended, by task id, kept briefly for a stop whose shell died before it reaped. */
  ended: Map<string, { leader: TaskLeader; at: number }>;
  notLeaders: Set<MemberKey>;
  /** Tasks already stopped, so a shell still dying is not taken for a new task. */
  stoppedTasks: Set<string>;
  /** Where this session's task output files live, once a task shell showed it. */
  tasksDir?: string;
  /** What still writes to this session's task outputs: it ends with the session. */
  sessionGroups: GroupMembers;
};
type TableIndex = {
  table: ProcessRow[];
  byPid: Map<number, ProcessRow>;
  children: Map<number, ProcessRow[]>;
};

const POLL_MS = 5000;
const TERM_GRACE_MS = 2000;
const ENDED_KEEP_MS = 30_000;
/** Reads tried before giving up on a process table or lsof cut off by load. */
const READ_TRIES = 3;
const TASK_OUTPUT = /^(.*\/tasks)\/([^/]+)\.output$/;

const clis = new Map<number, TrackedCli>();
/** Groups between SIGTERM and SIGKILL, so app quit can finish them. */
const terminating = new Set<GroupMembers>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let notes: Promise<void> = Promise.resolve();
let pendingPoll: Promise<void> | null = null;

const keyOf = (row: ProcessRow): MemberKey => `${row.pid}@${row.start}`;

/** The process reads the reaper makes; a test swaps one to model a read cut short. */
export const processReaders = {
  readOutputWriters,
  readProcessTable,
  readProcessTableSync,
  readStdoutPaths,
};

/** Notes a spawned Claude CLI's Bash tasks until it exits, then ends what they left running. */
export function trackClaudeCli(child: Pick<ChildProcess, 'pid' | 'stdin' | 'once'>): void {
  const pid = child.pid;
  if (pid === undefined || process.platform === 'win32') return;
  clis.set(pid, {
    leaders: new Map(),
    ended: new Map(),
    notLeaders: new Set(),
    stoppedTasks: new Set(),
    sessionGroups: new Map(),
  });
  // Frink's quit ends in app.exit, which emits this: the last moment to end what tasks started.
  if (!process.listeners('exit').includes(reapAllTaskGroupsSync)) {
    process.once('exit', reapAllTaskGroupsSync);
  }
  pollTimer ??= setInterval(() => void noteTaskGroupsNow(), POLL_MS);
  pollTimer.unref?.();
  // Closing stdin is how a session ends: note once more before the CLI acts on it.
  child.stdin?.once('close', () => void noteTaskGroupsNow({ teardown: true }));
  child.once('exit', () => void settleExit(pid));
}

/** Re-reads every tracked CLI's tasks. A teardown note also finds what writes to the session's task
 * outputs, and keeps tasks that look ended, since the CLI may be killing them as it reads. */
export function noteTaskGroupsNow(options: { teardown?: boolean } = {}): Promise<void> {
  if (options.teardown) return enqueueNote(true);
  pendingPoll ??= enqueueNote(false).finally(() => {
    pendingPoll = null;
  });
  return pendingPoll;
}

/** After a stop of one background task: ends the groups it left running, including any process
 * still writing to its output, even once its shell is gone. */
export async function reapStoppedTaskGroups(taskId: string): Promise<void> {
  // The stop's own note may still be queued behind a slow poll.
  await notes;
  const stopped: GroupMembers = new Map();
  // Registered before reading writers, so an app quit meanwhile still ends what is known.
  terminating.add(stopped);
  const outputs = new Map<TrackedCli, string>();
  for (const cli of clis.values()) {
    cli.stoppedTasks.add(taskId);
    const matching = [...cli.leaders].filter(([, leader]) => leader.taskId === taskId);
    for (const [key, leader] of matching) {
      mergeInto(stopped, leader.groups);
      cli.leaders.delete(key);
    }
    const ended = cli.ended.get(taskId);
    if (ended) mergeInto(stopped, ended.leader.groups);
    cli.ended.delete(taskId);
    if (cli.tasksDir) outputs.set(cli, `${cli.tasksDir}/${taskId}.output`);
  }
  for (const [cli, output] of outputs) {
    mergeInto(stopped, await writerGroups(cli, (path) => path === output));
  }
  await reapGroups(stopped, `task ${taskId} stopped`);
}

/** App quit: force-ends every noted group of a task still running, as Frink exits. */
export function reapAllTaskGroupsSync(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  if (clis.size === 0 && terminating.size === 0) return;
  let table: ProcessRow[] | null = null;
  for (let attempt = 0; attempt < 2 && !table; attempt++) {
    table = processReaders.readProcessTableSync();
  }
  if (!table) {
    // Without a table no member can be confirmed, and a blind signal could hit a reused group id.
    log.error('[Task groups] quit: process table unreadable, leftover task processes not ended');
    return;
  }
  recordGroups(indexTable(table), true);
  const protectedGroups = protectedPgids(table);
  const groups = mergeGroups([...[...clis.values()].flatMap(sessionGroupsOf), ...terminating]);
  clis.clear();
  terminating.clear();
  for (const pgid of groupsToSignal(groups, table, protectedGroups)) signalGroup(pgid, 'SIGKILL');
}

/** Noted groups that still hold a noted process; never a protected group or pgid 0/1. */
export function groupsToSignal(
  recorded: GroupMembers,
  table: ProcessRow[],
  protectedGroups: Set<number>,
): number[] {
  const live = new Map<number, Set<MemberKey>>();
  for (const row of table) {
    const members = live.get(row.pgid) ?? new Set();
    members.add(keyOf(row));
    live.set(row.pgid, members);
  }
  return [...recorded].flatMap(([pgid, members]) => {
    if (pgid <= 1 || protectedGroups.has(pgid)) return [];
    const now = live.get(pgid);
    return now && [...members].some((member) => now.has(member)) ? [pgid] : [];
  });
}

/** Frink's own group and every tracked CLI's: a CLI shares Frink's, and neither may be signalled. */
function protectedPgids(table: ProcessRow[]): Set<number> {
  const owners = new Set([process.pid, ...clis.keys()]);
  return new Set(table.filter((row) => owners.has(row.pid)).map((row) => row.pgid));
}

function enqueueNote(teardown: boolean): Promise<void> {
  notes = notes
    .then(() => noteOnce(teardown))
    .catch((error) => log.warn('[Task groups] note failed', error));
  return notes;
}

async function settleExit(pid: number): Promise<void> {
  // A teardown note may still be adding this CLI's groups.
  await notes;
  const cli = clis.get(pid);
  if (!cli) return;
  // No fresh walk: the CLI just killed its task shells. Output writers are read again (stdin may not
  // have closed); the CLI stays tracked until handed to the reap, so a quit meanwhile still ends it.
  const writers = await writerGroups(cli, () => true);
  const groups = mergeGroups([...sessionGroupsOf(cli), writers]);
  clis.delete(pid);
  if (clis.size === 0 && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  await reapGroups(groups, `cli ${pid} exited`);
}

/** A session's live tasks' groups and what wrote to its task outputs. */
function sessionGroupsOf(cli: TrackedCli): GroupMembers[] {
  return [...[...cli.leaders.values()].map((leader) => leader.groups), cli.sessionGroups];
}

/** The groups of processes writing to this session's outputs that `wanted` picks. */
async function writerGroups(
  cli: TrackedCli,
  wanted: (path: string) => boolean,
): Promise<GroupMembers> {
  const groups: GroupMembers = new Map();
  if (!cli.tasksDir) return groups;
  for (let attempt = 0; attempt < READ_TRIES; attempt++) {
    const table = await processReaders.readProcessTable();
    const writers = table ? await processReaders.readOutputWriters(cli.tasksDir, table) : null;
    // A read cut off under load is not "no writers": try again.
    if (!table || !writers) continue;
    const pids = new Set(
      writers.filter((writer) => wanted(writer.path)).map((writer) => writer.pid),
    );
    const pgids = new Set(table.filter((row) => pids.has(row.pid)).map((row) => row.pgid));
    addMembers(groups, pgids, table, protectedPgids(table));
    return groups;
  }
  log.warn(`[Task groups] could not read what writes to ${cli.tasksDir}`);
  return groups;
}

async function noteOnce(teardown: boolean): Promise<void> {
  const table = await processReaders.readProcessTable();
  // An unreadable table says nothing about which tasks ended.
  if (!table) return;
  const index = indexTable(table);
  await classifyNewChildren(index);
  recordGroups(index, teardown);
  if (!teardown) return;
  for (const cli of clis.values()) {
    cli.sessionGroups = mergeGroups([cli.sessionGroups, await writerGroups(cli, () => true)]);
  }
}

function indexTable(table: ProcessRow[]): TableIndex {
  const children = new Map<number, ProcessRow[]>();
  for (const row of table) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  return { table, byPid: new Map(table.map((row) => [row.pid, row])), children };
}

type Candidate = { cli: TrackedCli; row: ProcessRow };

async function classifyNewChildren(index: TableIndex): Promise<void> {
  const candidates = unclassifiedChildren(index);
  const stdout = await processReaders.readStdoutPaths([...candidates.keys()]);
  for (const [pid, candidate] of candidates) {
    const output = stdout.get(pid);
    // Unread (lsof stopped under load) is not "not a task": ask again next time.
    if (output !== undefined) classify(candidate, output);
  }
}

/** Each Bash call runs as a shell leading its own group, writing to its task's output file. */
function unclassifiedChildren({ byPid, children }: TableIndex): Map<number, Candidate> {
  const candidates = new Map<number, Candidate>();
  for (const [cliPid, cli] of clis) {
    if (!byPid.has(cliPid)) continue;
    const known = (key: MemberKey) => cli.leaders.has(key) || cli.notLeaders.has(key);
    for (const row of children.get(cliPid) ?? []) {
      if (row.pid === row.pgid && !known(keyOf(row))) candidates.set(row.pid, { cli, row });
    }
  }
  return candidates;
}

function classify({ cli, row }: Candidate, output: string): void {
  const [, tasksDir, taskId] = output.match(TASK_OUTPUT) ?? [];
  if (!taskId || cli.stoppedTasks.has(taskId)) {
    cli.notLeaders.add(keyOf(row));
    return;
  }
  cli.tasksDir ??= tasksDir;
  cli.leaders.set(keyOf(row), { pid: row.pid, taskId, groups: new Map() });
}

function recordGroups(index: TableIndex, keepEnded: boolean): void {
  const protectedGroups = protectedPgids(index.table);
  const now = Date.now();
  for (const [cliPid, cli] of clis) {
    if (!index.byPid.has(cliPid) && !keepEnded) continue;
    forgetGone(cli, index.byPid, now);
    for (const [key, leader] of cli.leaders) {
      if (isLive(key, index.byPid)) {
        const pgids = new Set(descendantGroups(leader.pid, index));
        addMembers(leader.groups, pgids, index.table, protectedGroups);
      } else if (!keepEnded) {
        // A task that ended on its own keeps what it started detached: a daemon may be the point.
        cli.leaders.delete(key);
        cli.ended.set(leader.taskId, { leader, at: now });
      }
    }
  }
}

/** Drops classifications of exited processes and ended tasks past the keep window. */
function forgetGone(cli: TrackedCli, byPid: Map<number, ProcessRow>, now: number): void {
  for (const key of cli.notLeaders) if (!isLive(key, byPid)) cli.notLeaders.delete(key);
  for (const [taskId, ended] of cli.ended) {
    if (now - ended.at > ENDED_KEEP_MS) cli.ended.delete(taskId);
  }
}

function isLive(key: MemberKey, byPid: Map<number, ProcessRow>): boolean {
  const row = byPid.get(Number.parseInt(key, 10));
  return row !== undefined && keyOf(row) === key;
}

/** Every group under the task shell. */
function descendantGroups(leaderPid: number, { children }: TableIndex): number[] {
  const pgids = new Set<number>([leaderPid]);
  const queue = [leaderPid];
  for (let pid = queue.pop(); pid !== undefined; pid = queue.pop()) {
    for (const child of children.get(pid) ?? []) {
      pgids.add(child.pgid);
      queue.push(child.pid);
    }
  }
  return [...pgids];
}

/** All of each group's members, not only the walked ones: some may already be orphaned. */
function addMembers(
  groups: GroupMembers,
  pgids: Set<number>,
  table: ProcessRow[],
  protectedGroups: Set<number>,
): void {
  for (const row of table) {
    if (!pgids.has(row.pgid) || protectedGroups.has(row.pgid)) continue;
    const members = groups.get(row.pgid) ?? new Set();
    members.add(keyOf(row));
    groups.set(row.pgid, members);
  }
}

function mergeInto(target: GroupMembers, source: GroupMembers): void {
  for (const [pgid, members] of source) {
    target.set(pgid, new Set([...(target.get(pgid) ?? []), ...members]));
  }
}

function mergeGroups(all: GroupMembers[]): GroupMembers {
  const merged: GroupMembers = new Map();
  for (const groups of all) {
    for (const [pgid, members] of groups) {
      merged.set(pgid, new Set([...(merged.get(pgid) ?? []), ...members]));
    }
  }
  return merged;
}

async function reapGroups(groups: GroupMembers, reason: string): Promise<void> {
  if (groups.size === 0) return;
  // Registered before the first await, so an app quit meanwhile force-ends them.
  terminating.add(groups);
  const termed = await signalLive(groups, 'SIGTERM');
  if (termed?.length === 0) {
    terminating.delete(groups);
    return;
  }
  log.info(`[Task groups] ${reason}: ending leftover process groups`);
  await new Promise((resolve) => setTimeout(resolve, TERM_GRACE_MS).unref?.());
  // App quit already force-ended them.
  if (!terminating.has(groups)) return;
  // Unreadable even now: left registered, so the quit sweep still ends them.
  if ((await signalLive(groups, 'SIGKILL')) !== null) terminating.delete(groups);
}

/** The groups signalled, or null when no process table could be read to confirm any member. */
async function signalLive(groups: GroupMembers, signal: NodeJS.Signals): Promise<number[] | null> {
  for (let attempt = 0; attempt < READ_TRIES; attempt++) {
    const table = await processReaders.readProcessTable();
    if (!table) continue;
    const targets = groupsToSignal(groups, table, protectedPgids(table));
    for (const pgid of targets) signalGroup(pgid, signal);
    return targets;
  }
  log.warn('[Task groups] process table unreadable; leftover groups kept for the next try');
  return null;
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // Emptied between the read and the signal.
  }
}

/** What a task stop uses to end what the task started beyond its shell's group. */
export type TaskGroupControls = {
  noteTaskGroupsNow: typeof noteTaskGroupsNow;
  reapStoppedTaskGroups: typeof reapStoppedTaskGroups;
};
export const TASK_GROUP_CONTROLS: TaskGroupControls = { noteTaskGroupsNow, reapStoppedTaskGroups };
