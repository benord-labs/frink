import {
  type AcpLaunchResult,
  type AcpLaunchRow,
  findRowBinary,
  type LaunchOptions,
  launchFromRows,
  locateRowBinary,
} from './launch';
import { OPENCODE_LAUNCH } from './opencode';

/** How Frink starts each agent it can run, by provider id: one row per checked version, oldest first. */
export const LAUNCH_ROWS = new Map<string, AcpLaunchRow[]>([['opencode', [OPENCODE_LAUNCH]]]);

const NO_ROW = "Frink can't start this agent yet.";

/** Prepares one turn's launch, checked before every turn so a changed install or setting is caught. */
export async function resolveAcpLaunch(
  agentId: string,
  cwd: string,
  options?: LaunchOptions,
): Promise<AcpLaunchResult> {
  const rows = LAUNCH_ROWS.get(agentId);
  return rows ? launchFromRows(rows, cwd, options) : { ok: false, reason: NO_ROW };
}

/** The installed agent and its version; it runs the agent once to read the version. */
export async function findAcpAgent(
  agentId: string,
  env?: Record<string, string>,
): Promise<{ path: string; version: string } | { reason: string; missing?: true }> {
  const rows = LAUNCH_ROWS.get(agentId);
  return rows ? findRowBinary(rows, env) : { reason: NO_ROW };
}

/** Where the agent is installed, without running it. */
export async function locateAcpAgent(
  agentId: string,
  env?: Record<string, string>,
): Promise<string | undefined> {
  const rows = LAUNCH_ROWS.get(agentId);
  return rows ? locateRowBinary(rows[0], env) : undefined;
}
