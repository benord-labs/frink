import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { findGitRoot, mainCheckout } from '../git/repo-root';
import {
  appRootOf,
  isIgnoredPort,
  labelFromCommand,
  listCommands,
  listCwds,
  listElectronAncestors,
  listListeners,
  toUrl,
} from './port-scanner';

const SCAN_INTERVAL_MS = 2500;

export type DevServer = {
  pid: number;
  port: number;
  label: string;
  url: string;
  cwd: string;
  /** Nearest folder above `cwd` holding a `.git` entry; null outside any repository. */
  gitRoot: string | null;
  /** The main checkout's real path when `gitRoot` is a linked worktree; null otherwise. */
  mainCheckout: string | null;
};

/** The chat's repository root, and which of its linked worktrees another chat or project owns. */
export type ChatRepo = { root: string; claimed: ReadonlySet<string> };

export type DevServerLink = Pick<DevServer, 'port' | 'label' | 'url'>;

type ServersListener = (servers: DevServer[]) => void;

/** The system calls a scan makes; tests pass fakes instead of the real lsof/ps calls. */
export type PortScanner = {
  listListeners: typeof listListeners;
  listCwds: typeof listCwds;
  listCommands: typeof listCommands;
  listElectronAncestors: typeof listElectronAncestors;
};

const systemScanner: PortScanner = {
  listListeners,
  listCwds,
  listCommands,
  listElectronAncestors,
};

function isInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

function inChatFolder(server: DevServer, chatPath: string): boolean {
  return (
    isInside(server.cwd, chatPath) &&
    (server.gitRoot === null || isInside(chatPath, server.gitRoot))
  );
}

/** The server's label naming its worktree, when it runs at the chat's folder in an unowned linked
 * worktree of the chat's repository; null otherwise. */
function linkedWorktreeLabel(server: DevServer, chatPath: string, repo?: ChatRepo): string | null {
  const { gitRoot } = server;
  if (!repo || gitRoot === null || server.mainCheckout !== repo.root) return null;
  if (repo.claimed.has(gitRoot)) return null;
  if (!isInside(server.cwd, path.join(gitRoot, path.relative(repo.root, chatPath)))) return null;
  return `${server.label} · ${path.basename(gitRoot)}`;
}

/**
 * Servers running inside `chatPath`, except those in a repository nested below it, plus servers
 * an agent started in an unowned linked worktree of the chat's repository, labelled with that worktree.
 */
export function devServersForPath(
  servers: DevServer[],
  chatPath: string,
  repo?: ChatRepo,
): DevServer[] {
  return servers.flatMap((server) => {
    if (inChatFolder(server, chatPath)) return [server];
    const label = linkedWorktreeLabel(server, chatPath, repo);
    return label === null ? [] : [{ ...server, label }];
  });
}

/** The real path of a linked worktree's main checkout; null for any other git root. */
function linkedMainCheckout(gitRoot: string): string | null {
  const main = mainCheckout(gitRoot);
  if (main === gitRoot) return null;
  try {
    return realpathSync.native(main);
  } catch {
    return null;
  }
}

/** Watches every listening TCP port on the machine while at least one chat is subscribed. */
export class PortManager {
  /** Each listener, and whether it hears every scan or only scans that change the list. */
  private listeners = new Map<ServersListener, boolean>();
  private servers: DevServer[] = [];
  private snapshotKey = '';
  private scanInterval: ReturnType<typeof setInterval> | null = null;
  private isScanning = false;
  private gitRoots = new Map<string, string | null>();
  private mainCheckouts = new Map<string, string | null>();

  /** Listeners run from `appRoot` are Frink's own helpers; agent and terminal servers run outside it. */
  constructor(
    private readonly scanner: PortScanner = systemScanner,
    private readonly appRoot: string = appRootOf(process.execPath),
  ) {}

  subscribe(listener: ServersListener, { everyScan = false } = {}): () => void {
    this.listeners.set(listener, everyScan);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  getServers(): DevServer[] {
    return this.servers;
  }

  private start(): void {
    void this.scan();
    this.scanInterval = setInterval(() => void this.scan(), SCAN_INTERVAL_MS);
    this.scanInterval.unref();
  }

  private stop(): void {
    if (this.scanInterval) clearInterval(this.scanInterval);
    this.scanInterval = null;
    this.servers = [];
    this.snapshotKey = '';
    this.gitRoots.clear();
    this.mainCheckouts.clear();
  }

  async scan(): Promise<void> {
    if (this.isScanning) return;
    this.isScanning = true;
    try {
      const open = (await this.scanner.listListeners()).filter(
        (listener) => !isIgnoredPort(listener.port),
      );
      const desktopRenderers = await this.scanner.listElectronAncestors(
        open.map((listener) => listener.pid),
      );
      const listening = open.filter((listener) => !desktopRenderers.has(listener.pid));
      const pids = [...new Set(listening.map((listener) => listener.pid))];
      const [cwds, commands] = await Promise.all([
        this.scanner.listCwds(pids),
        this.scanner.listCommands(pids),
      ]);

      const servers = new Map<string, DevServer>();
      for (const listener of listening) {
        const cwd = cwds.get(listener.pid);
        const command = commands.get(listener.pid) ?? '';
        // One link per address per folder: IPv4/IPv6 binds and processes sharing a socket collapse.
        const url = toUrl(listener.address, listener.port);
        const key = `${cwd}\0${url}`;
        if (!cwd || command.startsWith(this.appRoot) || servers.has(key)) continue;
        const gitRoot = this.gitRootFor(cwd);
        servers.set(key, {
          pid: listener.pid,
          port: listener.port,
          label: labelFromCommand(command, cwd) || listener.command || 'server',
          url,
          cwd,
          gitRoot,
          mainCheckout: gitRoot === null ? null : this.mainCheckoutFor(gitRoot),
        });
      }
      this.publish([...servers.values()].sort((a, b) => a.port - b.port));
    } finally {
      this.isScanning = false;
    }
  }

  private gitRootFor(cwd: string): string | null {
    const cached = this.gitRoots.get(cwd);
    if (cached !== undefined) return cached;
    const root = findGitRoot(cwd);
    this.gitRoots.set(cwd, root);
    return root;
  }

  private mainCheckoutFor(gitRoot: string): string | null {
    const cached = this.mainCheckouts.get(gitRoot);
    if (cached !== undefined) return cached;
    const main = linkedMainCheckout(gitRoot);
    this.mainCheckouts.set(gitRoot, main);
    return main;
  }

  private publish(servers: DevServer[]): void {
    if (this.listeners.size === 0) return;
    const key = JSON.stringify(servers);
    const changed = key !== this.snapshotKey;
    if (changed) {
      this.snapshotKey = key;
      this.servers = servers;
    }
    for (const [listener, everyScan] of this.listeners) {
      if (changed || everyScan) listener(this.servers);
    }
  }
}

const portManager = new PortManager();

/**
 * Streams the links for one chat folder: the current list right away, then every change.
 * `claimed` returns which of the given linked worktrees another chat or project owns; it is
 * re-checked on every scan, since a chat can claim a worktree while its server keeps running.
 * Returns the unsubscribe.
 */
export function watchDevServers(
  chatPath: string,
  onLinks: (links: DevServerLink[]) => void,
  manager: Pick<PortManager, 'subscribe' | 'getServers'> = portManager,
  claimed: (gitRoots: string[]) => ReadonlySet<string> = () => new Set(),
): () => void {
  let resolvedPath = path.resolve(chatPath);
  let repoRoot: string | null = null;
  const chatRepo = (servers: DevServer[]): ChatRepo | undefined => {
    const root = repoRoot;
    if (root === null) return undefined;
    const linked = new Set(
      servers.flatMap((server) =>
        server.gitRoot !== null && server.mainCheckout === root ? [server.gitRoot] : [],
      ),
    );
    return { root, claimed: linked.size > 0 ? claimed([...linked]) : linked };
  };
  let sentKey: string | null = null;
  const send = (servers: DevServer[]) => {
    const links = devServersForPath(servers, resolvedPath, chatRepo(servers)).map(
      ({ port, label, url }) => ({ port, label, url }),
    );
    const key = JSON.stringify(links);
    if (key === sentKey) return;
    sentKey = key;
    onLinks(links);
  };
  const unsubscribe = manager.subscribe(send, { everyScan: true });
  // lsof reports resolved folders, so match against the real path behind any symlink.
  // A folder that no longer exists keeps its given path and simply matches nothing.
  void fs.realpath(resolvedPath).then(
    (realPath) => {
      resolvedPath = realPath;
      repoRoot = findGitRoot(realPath);
      send(manager.getServers());
    },
    () => send(manager.getServers()),
  );
  return unsubscribe;
}
