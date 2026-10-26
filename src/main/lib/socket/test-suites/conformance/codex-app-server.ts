import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { z } from 'zod';
import type {
  CodexAppServerClient,
  CodexThreadSubscription,
} from '../../../agent-runner/codex/app-server-client';
import * as appServers from '../../../agent-runner/codex/app-server-registry';
import * as codexBinary from '../../../agent-runner/codex/codex-binary';
import { COMMAND_APPROVAL_METHOD } from '../../../agent-runner/codex/codex-events';
import { type CodexTurn, SESSION_ID } from './fixtures';

/** A Codex turn the fake plays after turn/start: the scripted ask first, then its notifications. */
type CodexTurnPlay = CodexTurn & {
  ask?: string;
  asksOpen?: Promise<void>;
  /** Where Codex's answer to the ask goes, as the runner's approval handler returned it. */
  end: { closed: boolean; allowed?: boolean | null };
};

type Subscription = {
  notify: Map<string, Parameters<CodexThreadSubscription['onNotification']>[1]>;
  answer: Map<string, Parameters<CodexThreadSubscription['onRequest']>[1]>;
};
/** One fake app-server: its sub-chat, spawn identity, servers handed and turn handlers. */
type Wire = { subChatId: string; spawnedWith: string; handed: string[]; sub?: Subscription };
type Server = Wire & { client: CodexAppServerClient };
/** The only part of a request the fake reads: the MCP servers a thread is started with. */
type ThreadRequest = { config?: { mcp_servers?: Record<string, boolean | { enabled: boolean }> } };
type Reply =
  | { thread: { id: string } }
  | { turn: { id: string } }
  | McpPage
  | Record<string, never>;
type McpPage = { data: { name: string }[]; nextCursor: null };
type FakeClient = Pick<CodexAppServerClient, 'forThread' | 'onClose' | 'onError'> & {
  sendRequest: (method: string, request?: ThreadRequest) => Promise<Reply>;
};
type ServerArgs = Parameters<typeof appServers.getCodexAppServer>;

const Answer = z.object({ decision: z.string() });
const NO_OP = { dispose: () => {} };
/** The next turn each sub-chat's app-server plays. */
const turns = new Map<string, CodexTurnPlay>();
/** The live fake per sub-chat. As in the registry, new spawn args or config replace it. */
const servers = new Map<string, Server>();

function subscribe(server: Wire): CodexThreadSubscription {
  const sub: Subscription = { notify: new Map(), answer: new Map() };
  server.sub = sub;
  return {
    onNotification: (method, handler) => {
      sub.notify.set(method, handler);
      return { dispose: () => sub.notify.delete(method) };
    },
    onRequest: (method, handler) => {
      sub.answer.set(method, handler);
      return { dispose: () => sub.answer.delete(method) };
    },
    expectTurnStart: () => {},
    bindTurn: () => {},
    dispose: () => {
      sub.notify.clear();
      sub.answer.clear();
    },
  };
}

/** Raises the turn's ask as Codex does, then replays its notifications into the turn. */
async function play(sub: Subscription, { notifications, ask, asksOpen, end }: CodexTurnPlay) {
  if (ask) {
    await asksOpen;
    // A turn that ended before its ask has no handler left; its row's own check then fails.
    const asked = sub.answer.get(COMMAND_APPROVAL_METHOD);
    if (!asked) return;
    end.allowed = Answer.parse(await asked({ itemId: 'ask', command: ask })).decision === 'accept';
  }
  for (const [method, params] of notifications) sub.notify.get(method)?.(params);
}

/** The servers a thread is started with; Frink's replace marker is `true`, not a server. */
function startThread(server: Wire, request: ThreadRequest): Reply {
  const handed = Object.entries(request.config?.mcp_servers ?? {});
  server.handed = handed.flatMap(([name, entry]) => (entry === true ? [] : [name]));
  return { thread: { id: SESSION_ID } };
}

/** Codex lists every MCP server a thread is started with, even one it cannot reach. */
function listMcpServers({ subChatId, handed }: Wire): Reply {
  const names = turns.get(subChatId)?.mcpServersListed ?? handed;
  return { data: names.map((name) => ({ name })), nextCursor: null };
}

/** Codex answers turn/start, then streams the turn. */
function startTurn({ subChatId, sub }: Wire): Reply {
  const turn = turns.get(subChatId);
  if (turn && sub) setImmediate(() => void play(sub, turn));
  return { turn: { id: randomUUID() } };
}

const REPLIES = {
  'thread/start': startThread,
  'mcpServerStatus/list': listMcpServers,
  'turn/start': startTurn,
} satisfies Record<string, (server: Wire, request: ThreadRequest) => Reply>;
const answered = (method: string): method is keyof typeof REPLIES => Object.hasOwn(REPLIES, method);

function createServer(wire: Wire): Server {
  const client: FakeClient = {
    forThread: () => subscribe(wire),
    sendRequest: async (method: string, request: ThreadRequest = {}) =>
      answered(method) ? REPLIES[method](wire, request) : {},
    onClose: () => NO_OP,
    onError: () => NO_OP,
  };
  // SAFETY: the runner, its loaded check and its Stop handler call only these four methods.
  return Object.assign(wire, { client: client as CodexAppServerClient });
}

/** The sub-chat's live fake, or a new one when it was spawned with other args or config. */
async function serverFor(...[cwd, credentialId, options, subChatId = '', revision]: ServerArgs) {
  const spawnedWith = JSON.stringify([cwd, credentialId, options.args, revision]);
  const live = servers.get(subChatId);
  if (live?.spawnedWith === spawnedWith) return live.client;
  const server = createServer({ subChatId, spawnedWith, handed: [] });
  servers.set(subChatId, server);
  return server.client;
}

/** Hands `turn` to the sub-chat's app-server, to play when the runner starts it. */
export function queueCodexTurn(subChatId: string, turn: CodexTurnPlay): void {
  turns.set(subChatId, turn);
}

/** Fakes the Codex binary and its app-servers so the real runner runs; returns the restore. */
export function fakeCodexAppServers(): () => void {
  const dispose = appServers.disposeCodexAppServerSession;
  const spies = [
    vi.spyOn(codexBinary, 'resolveCodexBinary').mockReturnValue('codex'),
    vi.spyOn(appServers, 'getCodexAppServer').mockImplementation(serverFor),
    // Stop ends the sub-chat's app-server, so its next turn starts a fresh thread.
    vi.spyOn(appServers, 'disposeCodexAppServerSession').mockImplementation((cwd, id, key) => {
      servers.delete(key);
      dispose(cwd, id, key);
    }),
  ];
  return () => {
    for (const spy of spies) spy.mockRestore();
    servers.clear();
    turns.clear();
  };
}
