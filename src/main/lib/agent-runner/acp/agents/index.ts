import {
  type AcpLaunchResult,
  findRowBinary,
  type LaunchOptions,
  launchFromRow,
  locateRowBinary,
} from './launch';
import { OPENCODE_LAUNCH } from './opencode';

/** How Frink starts each agent it can run, by provider id. */
const LAUNCH_ROWS = new Map([['opencode', OPENCODE_LAUNCH]]);

const NO_ROW = "Frink can't start this agent yet.";

/** Prepares one turn's launch, checked before every turn so a changed install or setting is caught. */
export async function resolveAcpLaunch(
  agentId: string,
  cwd: string,
  options?: LaunchOptions,
): Promise<AcpLaunchResult> {
  const row = LAUNCH_ROWS.get(agentId);
  return row ? launchFromRow(row, cwd, options) : { ok: false, reason: NO_ROW };
}

/** The installed agent and its version; it runs the agent once to read the version. */
export async function findAcpAgent(
  agentId: string,
): Promise<{ path: string; version: string } | { reason: string }> {
  const row = LAUNCH_ROWS.get(agentId);
  return row ? findRowBinary(row) : { reason: NO_ROW };
}

/** Where the agent is installed, without running it. */
export async function locateAcpAgent(agentId: string): Promise<string | undefined> {
  const row = LAUNCH_ROWS.get(agentId);
  return row ? locateRowBinary(row) : undefined;
}
