import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CLAUDE_API_KEY_FD_ENV } from '../../../claude/credential-fd-spawn';
import * as sessionPlanPaths from '../../../claude/session-plan-paths';
import * as database from '../../../db';
import { projects } from '../../../db/schema';
import { freshDb } from '../../../db/test-utils/fresh-db';
import { validateToolPermission } from '../../streaming/pending-permission/validate-tool-permission';
import { startScriptedAnthropicModel } from '../../test-suites/conformance/anthropic-model';
import { plantCanarySetup, registerCanaryRows } from '../../test-suites/conformance/canary';
import { buildClaudeSessionSpec, prepareClaudeSpawn } from './session-spec';

/** Launches a real Claude CLI (FRINK_CLAUDE_CANARY_BIN) as a Frink chat does, against a scripted
 * model on 127.0.0.1. The user's setup must reach the model request, with no account. */
const BIN = process.env.FRINK_CLAUDE_CANARY_BIN;
const REQUIRED = process.env.FRINK_CLAUDE_CANARY_REQUIRED === '1';
const TURN_MS = 120_000;
const AMBIENT = /^(ANTHROPIC_|CLAUDE)/;
/** The Claude keys a launch sets itself, then the two this test sets. */
const OWN_KEYS = new Set([
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_ENABLE_TASKS',
  CLAUDE_API_KEY_FD_ENV,
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
]);

it('ran against a real Claude CLI wherever the canary is required', () => {
  expect({ required: REQUIRED, bin: BIN ?? null }).not.toEqual({ required: true, bin: null });
});

/** Every Claude or Anthropic key in `env` the launch did not set itself. */
function ambientKeys(env: Record<string, string>): string[] {
  return Object.keys(env).filter((key) => AMBIENT.test(key) && !OWN_KEYS.has(key));
}

async function* oneUserMessageThenEnd(text: string): AsyncGenerator<SDKUserMessage> {
  yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}

describe.runIf(BIN)('Claude setup canary', () => {
  let root = '';
  let model: Awaited<ReturnType<typeof startScriptedAnthropicModel>>;
  let spec: Awaited<ReturnType<typeof buildClaudeSessionSpec>> | undefined;
  let turn: Promise<string[]> = Promise.resolve([]);

  beforeAll(async () => {
    // First: the login shell takes HOME from os.homedir(), so no developer profile loads.
    const home = process.env.FRINK_HOME ?? '';
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.stubEnv('HOME', home);
    if (process.platform === 'win32') vi.stubEnv('USERPROFILE', home);
    for (const key of Object.keys(process.env)) if (AMBIENT.test(key)) vi.stubEnv(key, undefined);
    model = await startScriptedAnthropicModel();
    vi.stubEnv('ANTHROPIC_BASE_URL', model.url);
    vi.stubEnv('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', '1');
    vi.stubEnv('DISABLE_AUTOUPDATER', '1');

    // A space, as in macOS's Application Support folder; the real path, as macOS links /var.
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'claude canary ')));
    const project = path.join(root, 'the project');
    await mkdir(project);
    execFileSync('git', ['init', '-q'], { cwd: project });
    const db = freshDb();
    vi.spyOn(database, 'getDatabase').mockReturnValue(db);
    const row = db.insert(projects).values({ name: 'Canary', path: project }).returning().get();
    vi.spyOn(sessionPlanPaths, 'claudeSessionsRoot').mockReturnValue(path.join(root, 'sessions'));
    await plantCanarySetup({ home, project });

    const built = await buildClaudeSessionSpec({
      chatId: 'canary-chat',
      subChatId: randomUUID(),
      project: row,
      projectId: row.id,
      projectPath: project,
      permissionProjectPath: project,
      mode: 'agent',
      settings: undefined,
      storedCredential: { token: 'not-a-key', isApiKey: true },
      nativeAutoReview: false,
      planAutoReview: false,
      persistedSessionId: undefined,
      claudeBinaryPath: BIN ?? '',
      dynamicChatMcpUrl: null,
      multiProjectPrefix: '',
      sessionFlowBriefing: '',
      signalTaskId: null,
      isFlowExecutionTurn: false,
      flowPlanAutoApprove: false,
      validateToolPermission,
      abortSources: new Map(),
    });
    spec = built;
    await prepareClaudeSpawn(built);
    // Same order as handleRemoteExecute and spawnPrewarm: --mcp-config exists only after stage().
    await built.mcpConfig?.stage();
    expect(ambientKeys(built.options.env)).toEqual([]);

    // The canonical keychain item stays out of the run; the credential still travels on fd 3.
    const env = { ...built.options.env, CLAUDE_SECURESTORAGE_CONFIG_DIR: built.configDir };
    const prompt = oneUserMessageThenEnd('Say done. case:canary');
    turn = (async () => {
      for await (const message of query({ prompt, options: { ...built.options, env } })) {
        if (message.type === 'result') break;
      }
      return model.requests;
    })();
    // Each row awaits the turn; this keeps an early failure from going unhandled meanwhile.
    turn.catch(() => {});
  }, TURN_MS);

  afterAll(async () => {
    await spec?.mcpConfig?.clear();
    model?.server.close();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  registerCanaryRows('claude-code', () => turn, TURN_MS);
});
