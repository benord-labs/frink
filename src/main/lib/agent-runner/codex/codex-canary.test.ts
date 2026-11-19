import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as database from '../../db';
import { projects } from '../../db/schema';
import { freshDb } from '../../db/test-utils/fresh-db';
import { resolveFrinkMcpServers } from '../../mcp/runtime';
import { ensureLoginShellEnv } from '../../platform/login-shell-env';
import { hooksForLaunch } from '../../provider/hooks/store';
import { deliverProviderConfig } from '../../socket/execution/provider-delivery';
import { plantCanarySetup, registerCanaryRows } from '../../socket/test-suites/conformance/canary';
import { startScriptedResponsesModel } from '../../socket/test-suites/conformance/responses-model';
import * as bundledBinary from '../bundled-binary';
import { disposeAllCodexAppServers } from './app-server-registry';
import { clearCodexBinaryCache, resolveCodexBinary } from './codex-binary';
import { runCodexAgent } from './codex-runner';

/** Starts the patched Codex app-server (FRINK_CODEX_CANARY_BIN) as a Frink chat does, against a
 * scripted Responses model on 127.0.0.1. The user's setup must reach the model request, no account. */
const BIN = process.env.FRINK_CODEX_CANARY_BIN;
const REQUIRED = process.env.FRINK_CODEX_CANARY_REQUIRED === '1';
const TURN_MS = 120_000;
const AMBIENT = /^(OPENAI_|CODEX_|AZURE_OPENAI_)/;

it('ran against a patched Codex wherever the canary is required', () => {
  expect({ required: REQUIRED, bin: BIN ?? null }).not.toEqual({ required: true, bin: null });
});

/** Points the app-server at the scripted model; a custom provider needs no sign-in. */
function scriptedProviderArgs(url: string): string[] {
  const provider = `{ name = "canary", base_url = "${url}", wire_api = "responses", request_max_retries = 0, stream_max_retries = 0 }`;
  return ['--config', 'model_provider="canary"', '--config', `model_providers.canary=${provider}`];
}

describe.runIf(BIN)('Codex setup canary', () => {
  let root = '';
  let model: Awaited<ReturnType<typeof startScriptedResponsesModel>>;
  const abortController = new AbortController();
  let turn: Promise<string[]> = Promise.resolve([]);

  beforeAll(async () => {
    // First: the login shell takes HOME from os.homedir(), so no developer profile loads.
    const home = process.env.FRINK_HOME ?? '';
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.stubEnv('HOME', home);
    if (process.platform === 'win32') vi.stubEnv('USERPROFILE', home);
    for (const key of Object.keys(process.env)) if (AMBIENT.test(key)) vi.stubEnv(key, undefined);
    model = await startScriptedResponsesModel();

    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'codex canary ')));
    const project = path.join(root, 'the project');
    await mkdir(project);
    execFileSync('git', ['init', '-q'], { cwd: project });
    const db = freshDb();
    vi.spyOn(database, 'getDatabase').mockReturnValue(db);
    const row = db.insert(projects).values({ name: 'Canary', path: project }).returning().get();
    vi.spyOn(bundledBinary, 'getBundledBinaryPath').mockReturnValue(BIN ?? '');
    clearCodexBinaryCache();
    expect(resolveCodexBinary(), 'CODEX_VERSION beside the binary must match the patch').toBe(BIN);
    await plantCanarySetup({ home, project });

    // Same order as handleRemoteExecute's Codex branch.
    await deliverProviderConfig(row, project, 'codex');
    const mcp = await resolveFrinkMcpServers({
      projectId: row.id,
      projectPath: project,
      dynamicChatMcpUrl: null,
    });
    const { hooks } = await hooksForLaunch('codex', project);
    await ensureLoginShellEnv();
    expect(Object.keys(process.env).filter((key) => AMBIENT.test(key))).toEqual([]);

    const chunks = runCodexAgent({
      prompt: 'Say done. case:canary',
      cwd: project,
      credentialId: 'canary',
      sessionKey: 'canary-sub-chat',
      env: { CLAUDE_PROJECT_DIR: project },
      abortController,
      mode: 'agent',
      configArgs: scriptedProviderArgs(model.url),
      canonicalMcpServers: mcp.servers,
      canonicalMcpEnvByServer: mcp.envByServer,
      userHooks: hooks,
      checkApproval: async () => ({ allowed: false, message: 'The canary asks for nothing.' }),
    });
    // A turn that never ends fails every row once, instead of each row after its own timeout.
    setTimeout(() => abortController.abort(), TURN_MS / 2).unref();
    turn = (async () => {
      for await (const chunk of chunks)
        if (chunk.type === 'error') throw new Error(chunk.errorText);
      return model.requests;
    })();
    // Each row awaits the turn; this keeps an early failure from going unhandled meanwhile.
    turn.catch(() => {});
  }, TURN_MS);

  afterAll(async () => {
    abortController.abort();
    disposeAllCodexAppServers();
    model?.server.close();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  registerCanaryRows('codex', () => turn, TURN_MS);
});
