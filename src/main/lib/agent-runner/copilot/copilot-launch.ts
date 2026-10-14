import path from 'node:path';
import { app } from 'electron';
import {
  findRowBinary,
  type InstalledAgentRow,
  locateRowBinary,
  userEnv,
} from '../acp/agents/launch';
import type { CopilotRunnerParams } from './copilot-runner';
import { COPILOT_TOOLS } from './copilot-tools';

type Env = Record<string, string>;

const COPILOT_ROW: InstalledAgentRow = {
  name: 'GitHub Copilot',
  binary: 'copilot',
  fallbacks: ['.local/bin/copilot'],
  versions: { floor: '1.0.96', below: '1.1.0' },
  versionPattern: /^GitHub Copilot CLI (\d+\.\d+\.\d+)/m,
  installHint: 'npm install -g @github/copilot',
};

/** No built-in GitHub MCP server and no remote control of the session. */
const ARGS = ['--disable-builtin-mcps', '--no-remote', '--no-remote-export'];
/** The user's own sign-in routes; every other Copilot variable could change how it asks. */
const KEPT_COPILOT_VARS = new Set(['COPILOT_GITHUB_TOKEN', 'COPILOT_HOME']);

export type CopilotLaunchResult =
  | { ok: true; launch: CopilotRunnerParams['launch'] }
  | { ok: false; reason: string };

/** The environment every Copilot run gets, its version check included. */
async function copilotEnv(start?: Env) {
  const env = start ?? (await userEnv());
  const kept = Object.entries(env).filter(
    ([key]) => !key.startsWith('COPILOT_') || KEPT_COPILOT_VARS.has(key),
  );
  return { ...Object.fromEntries(kept), COPILOT_DISABLE_LOGIN_SHELL_ENV: '1' };
}

/** Prepares one turn's launch, checked before every turn so a changed install is caught. */
export async function resolveCopilotLaunch(
  options: { env?: Env; configDirectory?: string } = {},
): Promise<CopilotLaunchResult> {
  const env = await copilotEnv(options.env);
  const found = await findRowBinary(COPILOT_ROW, env);
  if ('reason' in found) return { ok: false, reason: found.reason };
  const configDirectory =
    options.configDirectory ?? path.join(app.getPath('userData'), 'copilot', 'config');
  return {
    ok: true,
    launch: {
      command: found.path,
      args: [...ARGS],
      env,
      configDirectory,
      tools: COPILOT_TOOLS,
      versions: COPILOT_ROW.versions,
    },
  };
}

/** The installed CLI and its version; it runs the CLI once to read the version. */
export async function findCopilotAgent(env?: Env) {
  return findRowBinary(COPILOT_ROW, await copilotEnv(env));
}

/** Where the CLI is installed, without running it. */
export function locateCopilotAgent(env?: Env): Promise<string | undefined> {
  return locateRowBinary(COPILOT_ROW, env);
}
