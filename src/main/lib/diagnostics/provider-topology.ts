import { drainStreamCadenceSnapshot } from './stream-cadence';

const RECENT_WINDOW_MS = 60_000;
const MAX_RECENT_STARTS = 256;

let claudeQueryStartsTotal = 0;
let recentClaudeQueryStarts: number[] = [];
let codexTurnStartsTotal = 0;
let recentCodexTurnStarts: number[] = [];
let configuredMcpTotal = 0;
let configuredMcpStdio = 0;
let configuredMcpHttp = 0;
let readActiveExecutionCount = (): number => 0;
let readOwnerlessExecutionCount = (): number => 0;
type ClaudeSessionSummary = { total: number; busy: number; retained: number };
let readClaudeSessionSummary = (): ClaudeSessionSummary => ({ total: 0, busy: 0, retained: 0 });
let readCodexAppServerCount = (): number => 0;
let readCodexLiveTurnCount = (): number => 0;

function transportKind(config: unknown): 'stdio' | 'http' | 'unknown' {
  if (!config || typeof config !== 'object') return 'unknown';
  const record = config as Record<string, unknown>;
  // Real Frink HTTP configs retain command: ''; URL must win before checking a non-empty command.
  if (typeof record.url === 'string' && record.url.length > 0) return 'http';
  if (typeof record.command === 'string' && record.command.length > 0) return 'stdio';
  if (record.type === 'http') return 'http';
  if (record.type === 'stdio') return 'stdio';
  return 'unknown';
}

function pruneRecent(starts: number[], now: number): number[] {
  return starts
    .filter((startedAt) => now - startedAt <= RECENT_WINDOW_MS)
    .slice(-MAX_RECENT_STARTS);
}

/** Captured at app boot from Frink's metadata-only MCP config; never stores server identity. */
export function recordConfiguredMcpTopology(mcpServers: Record<string, unknown> | undefined): void {
  const configs = Object.values(mcpServers ?? {}).filter((config) => {
    if (!config || typeof config !== 'object') return true;
    return (config as Record<string, unknown>).enabled !== false;
  });
  configuredMcpTotal = configs.length;
  configuredMcpStdio = configs.filter((config) => transportKind(config) === 'stdio').length;
  configuredMcpHttp = configs.filter((config) => transportKind(config) === 'http').length;
}

/** Called only after createSession successfully creates a new Claude query. */
export function recordClaudeQueryStart(now = Date.now()): void {
  claudeQueryStartsTotal += 1;
  recentClaudeQueryStarts.push(now);
  recentClaudeQueryStarts = pruneRecent(recentClaudeQueryStarts, now);
}

/** Called only after Codex accepts a turn/start request. */
export function recordCodexTurnStart(now = Date.now()): void {
  codexTurnStartsTotal += 1;
  recentCodexTurnStarts.push(now);
  recentCodexTurnStarts = pruneRecent(recentCodexTurnStarts, now);
}

export function getClaudeTopologySnapshot(now = Date.now()) {
  recentClaudeQueryStarts = pruneRecent(recentClaudeQueryStarts, now);
  return {
    claudeQueryStartsTotal,
    claudeQueryStarts60s: recentClaudeQueryStarts.length,
    configuredMcpTotal,
    configuredMcpStdio,
    configuredMcpHttp,
  };
}

function getCodexTopologySnapshot(now = Date.now()) {
  recentCodexTurnStarts = pruneRecent(recentCodexTurnStarts, now);
  return {
    codexAppServerCount: readCodexAppServerCount(),
    codexLiveTurnCount: readCodexLiveTurnCount(),
    codexTurnStartsTotal,
    codexTurnStarts60s: recentCodexTurnStarts.length,
  };
}

export function registerActiveExecutionCountReader(reader: () => number): void {
  readActiveExecutionCount = reader;
}

/**
 * Runs no window owns: wake bursts, main-initiated runs, and any run whose window reloaded. Those
 * paint through the observer reducer after a bounded seed rather than a live delta transport, so a
 * chat watching one looks coarse BY DESIGN — this is what separates that from a genuine stall in an
 * incident report.
 */
export function registerOwnerlessExecutionCountReader(reader: () => number): void {
  readOwnerlessExecutionCount = reader;
}

export function registerClaudeSessionSummaryReader(reader: () => ClaudeSessionSummary): void {
  readClaudeSessionSummary = reader;
}

export function registerCodexAppServerCountReader(reader: () => number): void {
  readCodexAppServerCount = reader;
}

export function registerCodexLiveTurnCountReader(reader: () => number): void {
  readCodexLiveTurnCount = reader;
}

/**
 * NOT a pure getter: the stream-cadence fields are window-scoped, so reading them RESETS them.
 * Intended for the single diagnostics tick — a second caller in the same window (an OOM-time or
 * IPC read) gets zeros for those fields, having consumed the tick's data.
 */
export function getRuntimeTopologySnapshot(now = Date.now()) {
  const claudeSessions = readClaudeSessionSummary();
  return {
    activeExecutionCount: readActiveExecutionCount(),
    ownerlessExecutionCount: readOwnerlessExecutionCount(),
    ...drainStreamCadenceSnapshot(),
    claudeSessionCount: claudeSessions.total,
    claudeBusySessionCount: claudeSessions.busy,
    claudeRetainedSessionCount: claudeSessions.retained,
    ...getClaudeTopologySnapshot(now),
    ...getCodexTopologySnapshot(now),
  };
}

export function _resetProviderTopologyForTests(): void {
  claudeQueryStartsTotal = 0;
  recentClaudeQueryStarts = [];
  codexTurnStartsTotal = 0;
  recentCodexTurnStarts = [];
  configuredMcpTotal = 0;
  configuredMcpStdio = 0;
  configuredMcpHttp = 0;
  readActiveExecutionCount = () => 0;
  readOwnerlessExecutionCount = () => 0;
  readClaudeSessionSummary = () => ({ total: 0, busy: 0, retained: 0 });
  readCodexAppServerCount = () => 0;
  readCodexLiveTurnCount = () => 0;
}
