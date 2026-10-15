import fs from 'node:fs/promises';
import path from 'node:path';
import {
  appRootOf,
  isIgnoredPort,
  labelFromCommand,
  listCommands,
  listCwds,
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
};

export type DevServerLink = Pick<DevServer, 'port' | 'label' | 'url'>;

type ServersListener = (servers: DevServer[]) => void;

/** The system calls a scan makes; tests pass fakes instead of the real lsof/ps calls. */
export type PortScanner = {
  listListeners: typeof listListeners;
  listCwds: typeof listCwds;
  listCommands: typeof listCommands;
};

const systemScanner: PortScanner = { listListeners, listCwds, listCommands };

function isInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/** Servers running inside `chatPath`, except those in a repository nested below it. */
export function devServersForPath(servers: DevServer[], chatPath: string): DevServer[] {
  return servers.filter(
    (server) =>
      isInside(server.cwd, chatPath) &&
      (server.gitRoot === null || isInside(chatPath, server.gitRoot)),
  );
}

async function findGitRoot(cwd: string): Promise<string | null> {
  let dir = cwd;
  while (true) {
    try {
      await fs.stat(path.join(dir, '.git'));
      return dir;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
}

/** Watches every listening TCP port on the machine while at least one chat is subscribed. */
export class PortManager {
  private listeners = new Set<ServersListener>();
  private servers: DevServer[] = [];
  private snapshotKey = '';
  private scanInterval: ReturnType<typeof setInterval> | null = null;
  private isScanning = false;
  private gitRoots = new Map<string, string | null>();

  /** Listeners run from `appRoot` are Frink's own helpers; agent and terminal servers run outside it. */
  constructor(
    private readonly scanner: PortScanner = systemScanner,
    private readonly appRoot: string = appRootOf(process.execPath),
  ) {}

  subscribe(listener: ServersListener): () => void {
    this.listeners.add(listener);
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
  }

  async scan(): Promise<void> {
    if (this.isScanning) return;
    this.isScanning = true;
    try {
      const listening = (await this.scanner.listListeners()).filter(
        (listener) => !isIgnoredPort(listener.port),
      );
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
        servers.set(key, {
          pid: listener.pid,
          port: listener.port,
          label: labelFromCommand(command, cwd) || listener.command || 'server',
          url,
          cwd,
          gitRoot: await this.gitRootFor(cwd),
        });
      }
      this.publish([...servers.values()].sort((a, b) => a.port - b.port));
    } finally {
      this.isScanning = false;
    }
  }

  private async gitRootFor(cwd: string): Promise<string | null> {
    const cached = this.gitRoots.get(cwd);
    if (cached !== undefined) return cached;
    const root = await findGitRoot(cwd);
    this.gitRoots.set(cwd, root);
    return root;
  }

  private publish(servers: DevServer[]): void {
    const key = JSON.stringify(servers);
    if (this.listeners.size === 0 || key === this.snapshotKey) return;
    this.snapshotKey = key;
    this.servers = servers;
    for (const listener of this.listeners) listener(servers);
  }
}

const portManager = new PortManager();

/**
 * Streams the links for one chat folder: the current list right away, then every change.
 * Returns the unsubscribe.
 */
export function watchDevServers(
  chatPath: string,
  onLinks: (links: DevServerLink[]) => void,
  manager: Pick<PortManager, 'subscribe' | 'getServers'> = portManager,
): () => void {
  let resolvedPath = path.resolve(chatPath);
  const send = (servers: DevServer[]) => {
    onLinks(
      devServersForPath(servers, resolvedPath).map(({ port, label, url }) => ({
        port,
        label,
        url,
      })),
    );
  };
  const unsubscribe = manager.subscribe(send);
  // lsof reports resolved folders, so match against the real path behind any symlink.
  // A folder that no longer exists keeps its given path and simply matches nothing.
  void fs.realpath(resolvedPath).then(
    (realPath) => {
      resolvedPath = realPath;
      send(manager.getServers());
    },
    () => send(manager.getServers()),
  );
  return unsubscribe;
}
