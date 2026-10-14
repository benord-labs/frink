import { execFile } from 'node:child_process';
import path from 'node:path';

const EXEC_OPTIONS = { maxBuffer: 10 * 1024 * 1024, timeout: 5000 };
const ADDRESS_PORT_REGEX = /^(?:\[([^\]]+)\]|(.+)):(\d+)$/;
const WHITESPACE_SPLIT_REGEX = /\s+/;
const SCRIPT_EXTENSION_REGEX = /\.(?:[cm]?[jt]s|py|rb)$/;
const PS_LINE_REGEX = /^\s*(\d+)\s+(.*)$/;

/** Well-known service ports that are never a project's dev server. */
const IGNORED_PORTS = new Set([22, 80, 443, 5432, 3306, 6379, 27017]);
/** Chrome DevTools (9222) and Node inspector (9229) debugger range. */
const DEBUGGER_PORTS = { min: 9222, max: 9229 };
/** macOS/IANA ephemeral range: OS-assigned helper sockets, not servers someone opens. */
const EPHEMERAL_PORT_MIN = 49152;

/** Runtimes whose first script argument names the real tool (`node …/.bin/vite` → vite). */
const RUNTIME_REGEX = /^(?:node|bun|deno|ruby|python[\d.]*)$/i;
const RUNTIME_SUBCOMMANDS = new Set(['run', 'x', 'exec']);
/** Runtime flags whose next argument is their value, not the script (`node -r dotenv/config`). */
const RUNTIME_VALUE_FLAGS = new Set([
  '-r',
  '--require',
  '--import',
  '--loader',
  '-C',
  '--env-file',
]);
/** Flags that run inline code, so there is no script to name. */
const RUNTIME_EVAL_FLAGS = new Set(['-e', '--eval', '-p', '--print', '-c']);

export type Listener = {
  pid: number;
  command: string;
  address: string;
  port: number;
};

/** Where Frink's own executables live: the `.app` bundle on macOS, else the install folder. */
export function appRootOf(execPath: string): string {
  const bundleEnd = execPath.indexOf('.app/');
  return bundleEnd === -1 ? path.dirname(execPath) + path.sep : execPath.slice(0, bundleEnd + 5);
}

export function isIgnoredPort(port: number): boolean {
  return (
    IGNORED_PORTS.has(port) ||
    (port >= DEBUGGER_PORTS.min && port <= DEBUGGER_PORTS.max) ||
    port >= EPHEMERAL_PORT_MIN
  );
}

const LOOPBACK_OR_WILDCARD = new Set(['*', '0.0.0.0', '::', '::1', 'localhost']);

/** Loopback and wildcard binds open as localhost; a bind to one specific address must use it. */
export function toUrl(address: string, port: number): string {
  if (LOOPBACK_OR_WILDCARD.has(address) || address.startsWith('127.')) {
    return `http://localhost:${port}`;
  }
  const host = address.includes(':') ? `[${address}]` : address;
  return `http://${host}:${port}`;
}

/** Parses `lsof -F pcn` field output: `p<pid>`, `c<command>`, then `f<fd>`/`n<addr:port>` per socket. */
export function parseLsofListeners(stdout: string): Listener[] {
  const listeners: Listener[] = [];
  let pid = 0;
  let command = '';
  for (const line of stdout.split('\n')) {
    const field = line[0];
    const value = line.slice(1);
    if (field === 'p') {
      pid = Number.parseInt(value, 10);
      command = '';
    } else if (field === 'c') {
      command = value;
    } else if (field === 'n' && pid > 0) {
      const match = value.match(ADDRESS_PORT_REGEX);
      if (!match) continue;
      const port = Number.parseInt(match[3], 10);
      if (port < 1 || port > 65535) continue;
      listeners.push({ pid, command, address: match[1] ?? match[2], port });
    }
  }
  return listeners;
}

/** Parses `lsof -a -d cwd -Fpn` output into pid → working folder. */
export function parseLsofCwds(stdout: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid = 0;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number.parseInt(line.slice(1), 10);
    else if (line.startsWith('n') && pid > 0) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

/** Parses `ps -o pid=,command=` output into pid → full command line. */
export function parsePsCommands(stdout: string): Map<number, string> {
  const commands = new Map<number, string>();
  for (const line of stdout.split('\n')) {
    const match = line.match(PS_LINE_REGEX);
    if (match) commands.set(Number.parseInt(match[1], 10), match[2].trim());
  }
  return commands;
}

/** A short name for the server: the script a runtime runs, else the executable's name. */
export function labelFromCommand(command: string, cwd?: string): string | null {
  // ps joins argv with spaces, so a folder containing spaces would split a script path apart.
  const relative = cwd && cwd !== '/' ? command.replaceAll(cwd, '.') : command;
  const args = relative.trim().split(WHITESPACE_SPLIT_REGEX).filter(Boolean);
  if (args.length === 0) return null;
  const executable = path.basename(args[0]);
  if (!RUNTIME_REGEX.test(executable)) return executable;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (RUNTIME_EVAL_FLAGS.has(arg)) return executable;
    if (RUNTIME_VALUE_FLAGS.has(arg)) i++;
    else if (!arg.startsWith('-') && !RUNTIME_SUBCOMMANDS.has(arg)) {
      return path.basename(arg).replace(SCRIPT_EXTENSION_REGEX, '');
    }
  }
  return executable;
}

function run(file: string, args: string[]): Promise<string> {
  // lsof exits 1 when some pids could not be read but still prints the rest, so keep stdout
  // whatever the exit status; a missing binary simply yields no output.
  return new Promise((resolve) => {
    execFile(file, args, EXEC_OPTIONS, (_error, stdout) => resolve(stdout));
  });
}

export async function listListeners(): Promise<Listener[]> {
  if (process.platform === 'win32') return [];
  return parseLsofListeners(await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn']));
}

export async function listCwds(pids: number[]): Promise<Map<number, string>> {
  if (pids.length === 0) return new Map();
  return parseLsofCwds(await run('lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-F', 'pn']));
}

export async function listCommands(pids: number[]): Promise<Map<number, string>> {
  if (pids.length === 0) return new Map();
  return parsePsCommands(await run('ps', ['-o', 'pid=,command=', '-p', pids.join(',')]));
}
