import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type DevServer,
  devServersForPath,
  PortManager,
  type PortScanner,
  watchDevServers,
} from './port-manager';
import type { Listener } from './port-scanner';

const scanner = {
  listListeners: vi.fn<PortScanner['listListeners']>(),
  listCwds: vi.fn<PortScanner['listCwds']>(),
  listCommands: vi.fn<PortScanner['listCommands']>(),
  listElectronAncestors: vi.fn<PortScanner['listElectronAncestors']>(),
};
const APP_ROOT = '/Applications/Frink.app/';
const RENDERER_HELPER = `${APP_ROOT}Contents/Frameworks/Frink Helper (Renderer).app/Contents/MacOS/Frink Helper (Renderer) --type=renderer`;
let portManager = new PortManager(scanner, APP_ROOT);

let root: string;
let repo: string;
let worktree: string;
let linked: string;
let sibling: string;
let viaLink: string;

/** Lays out a linked worktree of `repo` at `dir` as `git worktree add` does, its pointer reaching
 * the repository through `repoPath`. */
function addLinkedWorktree(dir: string, repoPath: string): void {
  const name = path.basename(dir);
  const admin = path.join(repo, '.git', 'worktrees', name);
  fs.mkdirSync(admin, { recursive: true });
  fs.mkdirSync(path.join(dir, 'apps', 'web'), { recursive: true });
  fs.writeFileSync(path.join(admin, 'commondir'), '../..\n');
  fs.writeFileSync(path.join(admin, 'gitdir'), `${path.join(dir, '.git')}\n`);
  fs.writeFileSync(
    path.join(dir, '.git'),
    `gitdir: ${path.join(repoPath, '.git', 'worktrees', name)}\n`,
  );
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'port-manager-')));
  repo = path.join(root, 'repo');
  worktree = path.join(root, 'worktrees', 'feature');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'apps', 'web'), { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: elsewhere');
  linked = path.join(root, 'worktrees', 'linked');
  sibling = path.join(root, 'worktrees', 'sibling');
  viaLink = path.join(root, 'worktrees', 'via-link');
  addLinkedWorktree(linked, repo);
  addLinkedWorktree(sibling, repo);
  const repoLink = path.join(root, 'repo-link');
  fs.symlinkSync(repo, repoLink);
  addLinkedWorktree(viaLink, repoLink);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function serve(
  listeners: Array<Listener & { cwd: string; commandLine?: string }>,
  electronAncestors: number[] = [],
): void {
  scanner.listListeners.mockResolvedValue(listeners);
  scanner.listElectronAncestors.mockResolvedValue(new Set(electronAncestors));
  scanner.listCwds.mockResolvedValue(new Map(listeners.map((l) => [l.pid, l.cwd])));
  scanner.listCommands.mockImplementation(async (pids) => {
    const commands = new Map<number, string>();
    for (const l of listeners) {
      if (pids.includes(l.pid) && l.commandLine) commands.set(l.pid, l.commandLine);
    }
    return commands;
  });
}

const vite = (cwd: string, port = 5173) => ({
  pid: 100 + port,
  command: 'node',
  address: '::1',
  port,
  cwd,
  commandLine: `node ${cwd}/node_modules/.bin/vite`,
});

describe('portManager', () => {
  let unsubscribe: (() => void) | undefined;
  let scansStarted = 0;

  /** Fires the next interval tick and waits for that scan, which awaits real fs calls, to finish. */
  async function tick(): Promise<void> {
    scansStarted += 1;
    vi.advanceTimersByTime(2500);
    await settle();
  }

  async function settle(): Promise<void> {
    await vi.waitFor(() => expect(scanner.listListeners).toHaveBeenCalledTimes(scansStarted));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  async function subscribe(listener: Parameters<typeof portManager.subscribe>[0]): Promise<void> {
    scansStarted += 1;
    unsubscribe = portManager.subscribe(listener);
    await settle();
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    portManager = new PortManager(scanner, APP_ROOT);
    scansStarted = 0;
    serve([]);
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = undefined;
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('does not scan until someone subscribes, and stops after the last one leaves', async () => {
    vi.advanceTimersByTime(10_000);
    expect(scanner.listListeners).not.toHaveBeenCalled();

    await subscribe(() => {});
    await tick();
    expect(scanner.listListeners).toHaveBeenCalledTimes(2);

    unsubscribe?.();
    unsubscribe = undefined;
    vi.advanceTimersByTime(10_000);
    expect(scanner.listListeners).toHaveBeenCalledTimes(2);
  });

  it('publishes a server when it starts and drops it once it exits', async () => {
    const snapshots: DevServer[][] = [];
    serve([vite(worktree)]);
    await subscribe((servers) => snapshots.push(servers));

    expect(snapshots).toEqual([
      [
        {
          pid: 5273,
          port: 5173,
          label: 'vite',
          url: 'http://localhost:5173',
          cwd: worktree,
          gitRoot: worktree,
          mainCheckout: null,
        },
      ],
    ]);

    serve([]);
    await tick();
    expect(snapshots).toEqual([snapshots[0], []]);
  });

  it('stays quiet while nothing changes', async () => {
    const onChange = vi.fn();
    serve([vite(worktree)]);
    await subscribe(onChange);
    await tick();
    await tick();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("skips Frink's own app processes, ignored ports and duplicate IPv4/IPv6 binds", async () => {
    const onChange = vi.fn();
    serve([
      vite(worktree),
      { ...vite(worktree), address: '127.0.0.1' },
      {
        pid: 42,
        command: 'Frink Helper',
        address: '127.0.0.1',
        port: 5300,
        cwd: worktree,
        commandLine: RENDERER_HELPER,
      },
      { pid: 7, command: 'node', address: '127.0.0.1', port: 9229, cwd: worktree },
      { pid: 8, command: 'node', address: '*', port: 51118, cwd: worktree },
    ]);
    await subscribe(onChange);
    expect(onChange.mock.calls[0][0].map((s: DevServer) => s.port)).toEqual([5173]);
  });

  it("hides a desktop app's renderer server and keeps a web server beside it", async () => {
    const onChange = vi.fn();
    serve([vite(worktree, 5173), vite(worktree, 5174)], [vite(worktree, 5173).pid]);
    await subscribe(onChange);
    expect(onChange.mock.calls[0][0].map((s: DevServer) => s.port)).toEqual([5174]);
  });

  it('keeps a server an agent or a Frink terminal started, which runs outside the app bundle', async () => {
    const onChange = vi.fn();
    serve([
      {
        pid: 60,
        command: 'node',
        address: '*',
        port: 5174,
        cwd: worktree,
        commandLine: `/opt/homebrew/bin/node ${worktree}/node_modules/.bin/vite --port 5174`,
      },
    ]);
    await subscribe(onChange);
    expect(onChange.mock.calls[0][0]).toEqual([
      expect.objectContaining({ port: 5174, label: 'vite' }),
    ]);
  });

  it('shows one link for a server whose socket several processes in its folder share', async () => {
    const onChange = vi.fn();
    serve([
      { pid: 20, command: 'node', address: '*', port: 3000, cwd: worktree },
      { pid: 21, command: 'node', address: '*', port: 3000, cwd: worktree },
      { pid: 30, command: 'node', address: '127.0.0.1', port: 4000, cwd: worktree },
      { pid: 31, command: 'node', address: '::1', port: 4000, cwd: repo },
    ]);
    await subscribe(onChange);
    expect(onChange.mock.calls[0][0].map((s: DevServer) => [s.pid, s.port])).toEqual([
      [20, 3000],
      [30, 4000],
      [31, 4000],
    ]);
  });

  it('skips a tick while the previous scan is still running', async () => {
    let finish: (listeners: Listener[]) => void = () => {};
    scanner.listListeners.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    unsubscribe = portManager.subscribe(() => {});
    vi.advanceTimersByTime(2500 * 3);
    expect(scanner.listListeners).toHaveBeenCalledTimes(1);
    finish([]);
    scansStarted = 1;
    await settle();
  });

  it('keeps scanning while a second split pane still watches', async () => {
    const second = vi.fn();
    await subscribe(() => {});
    const leaveSecond = portManager.subscribe(second);
    unsubscribe?.();
    unsubscribe = leaveSecond;
    serve([vite(worktree)]);
    await tick();
    expect(second).toHaveBeenCalledWith([expect.objectContaining({ port: 5173 })]);
  });

  it('delivers to a chat that resubscribes while the last scan is still running', async () => {
    let finish: (listeners: Listener[]) => void = () => {};
    scanner.listListeners.mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const first = portManager.subscribe(() => {});
    first();
    const next = vi.fn();
    unsubscribe = portManager.subscribe(next);
    serve([vite(worktree)]);
    finish([vite(worktree)]);
    await vi.waitFor(() =>
      expect(next).toHaveBeenCalledWith([expect.objectContaining({ port: 5173 })]),
    );
  });

  it('falls back to the lsof command name when the full command is unknown', async () => {
    const onChange = vi.fn();
    serve([{ pid: 9, command: 'caddy', address: '*', port: 8080, cwd: repo }]);
    await subscribe(onChange);
    expect(onChange.mock.calls[0][0][0]).toMatchObject({ label: 'caddy', gitRoot: repo });
  });
});

describe('devServersForPath', () => {
  const server = (
    cwd: string,
    gitRoot: string | null,
    mainCheckout: string | null = null,
  ): DevServer => ({
    pid: 1,
    port: 5173,
    label: 'vite',
    url: 'http://localhost:5173',
    cwd,
    gitRoot,
    mainCheckout,
  });

  it('keeps sibling worktrees apart', () => {
    const a = server('/w/a', '/w/a');
    const b = server('/w/b/src', '/w/b');
    expect(devServersForPath([a, b], '/w/a')).toEqual([a]);
    expect(devServersForPath([a, b], '/w/b')).toEqual([b]);
    expect(devServersForPath([a, b], '/w/ab')).toEqual([]);
  });

  it("keeps a worktree nested in a project folder out of that project's chat", () => {
    const nested = server('/repo/.worktrees/x', '/repo/.worktrees/x');
    expect(devServersForPath([nested], '/repo')).toEqual([]);
    expect(devServersForPath([nested], '/repo/.worktrees/x')).toEqual([nested]);
  });

  it('matches a project that is a sub-folder of its repository', () => {
    const web = server('/mono/apps/web', '/mono');
    expect(devServersForPath([web], '/mono/apps/web')).toEqual([web]);
  });

  it('matches by folder alone outside any repository', () => {
    const loose = server('/scratch/site', null);
    expect(devServersForPath([loose], '/scratch')).toEqual([loose]);
  });

  it("adds an unowned linked worktree of the chat's repository, named in its label", () => {
    const agent = server('/wt/x', '/wt/x', '/repo');
    const repo = { root: '/repo', claimed: new Set<string>() };
    expect(devServersForPath([agent], '/repo', repo)).toEqual([{ ...agent, label: 'vite · x' }]);
    expect(devServersForPath([agent], '/repo')).toEqual([]);
    expect(devServersForPath([agent], '/other', { root: '/other', claimed: new Set() })).toEqual(
      [],
    );
  });

  it('leaves out a linked worktree another chat or project owns', () => {
    const owned = server('/wt/x', '/wt/x', '/repo');
    expect(
      devServersForPath([owned], '/repo', { root: '/repo', claimed: new Set(['/wt/x']) }),
    ).toEqual([]);
  });

  it("lists a linked worktree nested in the main checkout's folder under its own name", () => {
    const nested = server('/repo/.claude/worktrees/x', '/repo/.claude/worktrees/x', '/repo');
    const repo = { root: '/repo', claimed: new Set<string>() };
    expect(devServersForPath([nested], '/repo', repo)).toEqual([{ ...nested, label: 'vite · x' }]);
  });

  it("matches a linked worktree at the chat's sub-folder of the repository", () => {
    const web = server('/wt/x/apps/web', '/wt/x', '/repo');
    const top = server('/wt/x', '/wt/x', '/repo');
    const repo = { root: '/repo', claimed: new Set<string>() };
    expect(devServersForPath([web, top], '/repo/apps/web', repo)).toEqual([
      { ...web, label: 'vite · x' },
    ]);
  });
});

describe('watchDevServers', () => {
  const linksFor = (cwd: string, port: number) => vite(cwd, port);

  beforeEach(() => {
    portManager = new PortManager(scanner, APP_ROOT);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sends only the chat's servers, first on subscribe and then on change, until it stops", async () => {
    serve([linksFor(worktree, 5173), linksFor(repo, 5174)]);
    const received: unknown[] = [];
    const stop = watchDevServers(worktree, (links) => received.push(links), portManager);

    await vi.waitFor(() =>
      expect(received.at(-1)).toEqual([
        { port: 5173, label: 'vite', url: 'http://localhost:5173' },
      ]),
    );

    serve([linksFor(repo, 5174)]);
    await portManager.scan();
    expect(received.at(-1)).toEqual([]);

    stop();
    const count = received.length;
    serve([linksFor(worktree, 5173)]);
    await portManager.scan();
    expect(received).toHaveLength(count);
  });

  it('matches through a symlink to the chat folder', async () => {
    const link = path.join(root, 'link-to-worktree');
    fs.symlinkSync(worktree, link);
    serve([linksFor(worktree, 5173)]);
    const received: unknown[] = [];
    const stop = watchDevServers(link, (links) => received.push(links), portManager);

    await vi.waitFor(() =>
      expect(received.at(-1)).toEqual([
        { port: 5173, label: 'vite', url: 'http://localhost:5173' },
      ]),
    );
    stop();
  });

  it("lists an agent's server in an unowned linked worktree for the main checkout's chat", async () => {
    serve([linksFor(repo, 5174), linksFor(linked, 5175), linksFor(worktree, 5176)]);
    const received: unknown[] = [];
    const claimed = vi.fn(() => new Set<string>());
    const stop = watchDevServers(repo, (links) => received.push(links), portManager, claimed);

    await vi.waitFor(() =>
      expect(received.at(-1)).toEqual([
        { port: 5174, label: 'vite', url: 'http://localhost:5174' },
        { port: 5175, label: 'vite · linked', url: 'http://localhost:5175' },
      ]),
    );
    expect(claimed).toHaveBeenLastCalledWith([linked]);
    stop();
  });

  it('drops a link once another chat claims its worktree, and restores it once released', async () => {
    serve([linksFor(linked, 5175)]);
    const owned = new Set<string>();
    const main: unknown[] = [];
    const owner: unknown[] = [];
    const stopMain = watchDevServers(
      repo,
      (links) => main.push(links),
      portManager,
      (gitRoots) => new Set(gitRoots.filter((gitRoot) => owned.has(gitRoot))),
    );
    const stopOwner = watchDevServers(linked, (links) => owner.push(links), portManager);
    const listed = [{ port: 5175, label: 'vite · linked', url: 'http://localhost:5175' }];
    await vi.waitFor(() => expect(main.at(-1)).toEqual(listed));

    owned.add(linked);
    await vi.waitFor(async () => {
      await portManager.scan();
      expect(main.at(-1)).toEqual([]);
    });
    expect(owner.at(-1)).toEqual([{ port: 5175, label: 'vite', url: 'http://localhost:5175' }]);

    owned.delete(linked);
    await vi.waitFor(async () => {
      await portManager.scan();
      expect(main.at(-1)).toEqual(listed);
    });
    const sent = main.length;
    await portManager.scan();
    expect(main).toHaveLength(sent);
    stopMain();
    stopOwner();
  });

  it("matches the linked worktree's copy of a sub-folder chat's folder", async () => {
    serve([linksFor(linked, 5175), linksFor(path.join(linked, 'apps', 'web'), 5176)]);
    const received: unknown[] = [];
    const stop = watchDevServers(
      path.join(repo, 'apps', 'web'),
      (links) => received.push(links),
      portManager,
    );

    await vi.waitFor(() =>
      expect(received.at(-1)).toEqual([
        { port: 5176, label: 'vite · linked', url: 'http://localhost:5176' },
      ]),
    );
    stop();
  });

  it("keeps one worktree chat's servers out of a sibling worktree chat of the same repository", async () => {
    serve([linksFor(linked, 5175), linksFor(sibling, 5176)]);
    const received: unknown[] = [];
    const claimed = vi.fn(() => new Set<string>());
    const stop = watchDevServers(sibling, (links) => received.push(links), portManager, claimed);

    await vi.waitFor(() =>
      expect(received.at(-1)).toEqual([
        { port: 5176, label: 'vite', url: 'http://localhost:5176' },
      ]),
    );
    await portManager.scan();
    expect(received.at(-1)).toEqual([{ port: 5176, label: 'vite', url: 'http://localhost:5176' }]);
    expect(claimed).not.toHaveBeenCalled();
    stop();
  });

  it('matches a worktree whose pointer reaches the main checkout through a symlink', async () => {
    serve([linksFor(viaLink, 5177)]);
    const received: unknown[] = [];
    const stop = watchDevServers(repo, (links) => received.push(links), portManager);

    await vi.waitFor(() =>
      expect(received.at(-1)).toEqual([
        { port: 5177, label: 'vite · via-link', url: 'http://localhost:5177' },
      ]),
    );
    stop();
  });

  it('matches nothing once the chat folder no longer exists', async () => {
    serve([linksFor(worktree, 5173)]);
    const received: unknown[] = [];
    const stop = watchDevServers(
      path.join(root, 'deleted'),
      (links) => received.push(links),
      portManager,
    );
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(0));
    await portManager.scan();
    expect(received.every((links) => Array.isArray(links) && links.length === 0)).toBe(true);
    stop();
  });
});
