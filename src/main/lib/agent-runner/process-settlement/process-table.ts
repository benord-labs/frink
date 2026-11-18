import { execFile, execFileSync } from 'node:child_process';
import { readlink } from 'node:fs/promises';
import { parseLsofEntries, parseLsofPaths } from '../../terminal/port-scanner';

export type ProcessRow = { pid: number; ppid: number; pgid: number; start: string };

/** How a command ended: `stopped` when its timeout cut it off, so its output is incomplete. */
type RunResult = { failed: boolean; stopped: boolean; stdout: string };
export type RunFile = (file: string, args: string[]) => Promise<RunResult>;

const PS_ARGS = ['-A', '-o', 'pid=,ppid=,pgid=,lstart='];
const EXEC_OPTIONS = { maxBuffer: 10 * 1024 * 1024, timeout: 5000 };
const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/;

const runFile: RunFile = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, EXEC_OPTIONS, (error, stdout) =>
      resolve({
        failed: error !== null,
        stopped: Boolean(error?.killed || error?.signal),
        stdout,
      }),
    );
  });

/** Parses `ps -o pid=,ppid=,pgid=,lstart=`; the start time tells a reused pid from the old one. */
export function parseProcessTable(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split('\n')) {
    const match = line.match(PS_ROW);
    if (!match) continue;
    const [, pid, ppid, pgid, start] = match;
    rows.push({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), start });
  }
  return rows;
}

/** Every process on the machine; null when ps fails, since a cut-off table reads as dead tasks. */
export async function readProcessTable(run: RunFile = runFile): Promise<ProcessRow[] | null> {
  const ps = await run('ps', PS_ARGS);
  return ps.failed ? null : parseProcessTable(ps.stdout);
}

/** The same table, read synchronously for app quit, when no timer may fire again. */
export function readProcessTableSync(): ProcessRow[] | null {
  try {
    return parseProcessTable(execFileSync('ps', PS_ARGS, { ...EXEC_OPTIONS, encoding: 'utf8' }));
  } catch {
    return null;
  }
}

/** pid → the file each process has open as stdout. Pids whose fd 1 cannot be read are left out. */
export async function readStdoutPaths(
  pids: number[],
  run: RunFile = runFile,
): Promise<Map<number, string>> {
  if (pids.length === 0) return new Map();
  if (process.platform === 'linux') {
    const paths = new Map<number, string>();
    for (const { pid, path } of await readProcFds(pids, [1])) paths.set(pid, path);
    return paths;
  }
  return parseLsofPaths(await runLsof(run, ['-a', '-d', '1', '-p', pids.join(','), '-F', 'pn']));
}

/** Each process writing to a file directly in `dir` on stdout or stderr; null when lsof was cut
 * off, which is not the same as "no writers". */
export async function readOutputWriters(
  dir: string,
  table: ProcessRow[],
  run: RunFile = runFile,
): Promise<{ pid: number; path: string }[] | null> {
  const inDir = (path: string) =>
    path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes('/');
  if (process.platform === 'linux') {
    const entries = await readProcFds(
      table.map((row) => row.pid),
      [1, 2],
    );
    return entries.filter((entry) => inDir(entry.path));
  }
  const lsof = await run('lsof', ['-a', '-d', '1,2', '-F', 'pn', '+d', dir]);
  return lsof.stopped ? null : parseLsofEntries(lsof.stdout).filter((entry) => inDir(entry.path));
}

/** Linux names an unlinked file `<path> (deleted)`; the path is what identifies the task. */
async function readProcFds(pids: number[], fds: number[]) {
  const entries = await Promise.all(
    pids.flatMap((pid) =>
      fds.map(async (fd) => {
        const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '');
        return { pid, path: target.replace(/ \(deleted\)$/, '') };
      }),
    ),
  );
  return entries.filter((entry) => entry.path !== '');
}

/** lsof exits 1 when some pids or files could not be read but still prints the rest. */
async function runLsof(run: RunFile, args: string[]): Promise<string> {
  const lsof = await run('lsof', args);
  return lsof.stopped ? '' : lsof.stdout;
}
