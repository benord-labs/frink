import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findAcpAgent } from '../../agent-runner/acp';
import { findCopilotAgent } from '../../agent-runner/copilot';
import type { PickerGroupFields } from '../../../../shared/lib/model-picker-label/groups';
import type { DetectCodexAccountResult } from '../../credentials/detect-codex';
import * as schema from '../../db/schema';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';
import { createAgentAccountsRouter } from './agent-accounts';

/** Stands in for an installed OpenCode: it only prints its version. */
const FAKE_OPENCODE = `#!/bin/sh
[ "$1" = --version ] && printf '%s\\n' "$FAKE_VERSION"
`;
const FAKE_COPILOT = `#!/bin/sh
[ "$1" = --version ] && printf 'GitHub Copilot CLI %s.\\n' "$FAKE_VERSION"
`;

const ON = { opencodeAccounts: true };
const CODEX_ON = { codexAccounts: true };
const COPILOT_ON = { copilotAccounts: true };
const COPILOT_MODELS: PickerGroupFields[] = [
  { id: 'gpt-5/medium', name: 'GPT-5', familyId: 'gpt-5', effort: 'medium', effortDefault: true },
  { id: 'gpt-5/high', name: 'GPT-5', familyId: 'gpt-5', effort: 'high' },
];
const CODEX_LOGIN = {
  available: true,
  email: 'me@openai.example',
  sourcePath: 'codex-passthrough://local',
};

describe('agentAccounts', () => {
  let root = '';
  let db: TestDb;
  let env = { PATH: '', HOME: '', FAKE_VERSION: '' };
  const detectCodex = vi.fn<() => Promise<DetectCodexAccountResult>>();

  const caller = (flags: Record<string, boolean> = ON, platform = 'darwin') =>
    createAgentAccountsRouter({
      db: () => db,
      findAgent: (type) => findAcpAgent(type, env),
      findCopilot: () => findCopilotAgent(env),
      detectCodex,
      rememberedModels: (type) =>
        type === 'opencode' ? [{ id: 'opencode/big-pickle', name: 'Big Pickle' }] : undefined,
      copilotModels: () => COPILOT_MODELS,
      flags,
      platform,
    }).createCaller({ getWindow: () => null });
  const rows = () => db.select().from(schema.claudeCodeCredentials).all();

  beforeEach(async () => {
    db = freshDb();
    root = await mkdtemp(path.join(os.tmpdir(), 'agent accounts '));
    const bin = path.join(root, 'bin');
    await mkdir(bin);
    await writeFile(path.join(bin, 'opencode'), FAKE_OPENCODE, { mode: 0o755 });
    await writeFile(path.join(bin, 'copilot'), FAKE_COPILOT, { mode: 0o755 });
    env = { PATH: bin, HOME: root, FAKE_VERSION: '1.19.4' };
    detectCodex.mockReset().mockResolvedValue(CODEX_LOGIN);
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('finds an installed OpenCode and its version', async () => {
    await expect(caller().detect({ type: 'opencode' })).resolves.toEqual({
      available: true,
      version: '1.19.4',
    });
  });

  it('connects one OpenCode per device, with no stored sign-in', async () => {
    await db.insert(schema.claudeCodeCredentials).values({ id: 'claude', isDefault: true });

    await expect(caller().connect({ type: 'opencode' })).resolves.toMatchObject({
      status: 'created',
    });
    const [connected] = rows().filter((row) => row.type === 'opencode');
    expect(connected).toMatchObject({
      accountLabel: 'OpenCode',
      source: 'opencode-passthrough',
      oauthToken: null,
      isDefault: false,
    });

    await expect(caller().connect({ type: 'opencode', accountLabel: 'Work' })).resolves.toEqual({
      accountId: connected?.id,
      status: 'updated',
    });
    await expect(caller().connect({ type: 'opencode' })).resolves.toMatchObject({
      status: 'updated',
    });
    expect(rows().filter((row) => row.type === 'opencode')).toEqual([
      expect.objectContaining({ id: connected?.id, accountLabel: 'Work' }),
    ]);
  });

  it('makes the first account on this computer the default', async () => {
    await caller().connect({ type: 'opencode' });
    expect(rows()).toEqual([expect.objectContaining({ type: 'opencode', isDefault: true })]);
  });

  it('refuses a version Frink has not checked, in plain words', async () => {
    env.FAKE_VERSION = '1.20.0';
    const reason =
      "Frink has checked OpenCode 1.19. You have 1.20.0, which Frink hasn't checked yet. To use OpenCode in Frink now, go back to OpenCode 1.19.";

    await expect(caller().detect({ type: 'opencode' })).resolves.toEqual({
      available: false,
      reason,
    });
    await expect(caller().connect({ type: 'opencode' })).rejects.toThrow(reason);
    expect(rows()).toEqual([]);
  });

  it('says how to install OpenCode when it is missing', async () => {
    env.PATH = path.join(root, 'empty');

    await expect(caller().detect({ type: 'opencode' })).resolves.toEqual({
      available: false,
      reason: expect.stringContaining('npm install -g opencode-ai@1.19'),
      missing: true,
    });
  });

  it.each([
    ['switched off', {}, 'darwin', 'opencode'],
    ['not checked on Windows', ON, 'win32', 'opencode'],
    ['Claude, which has its own sign-in', ON, 'darwin', 'claude-code'],
    ['OpenAI, switched off', ON, 'darwin', 'codex'],
    ['GitHub Copilot, switched off', ON, 'darwin', 'copilot'],
    ['GitHub Copilot, not checked on Linux', COPILOT_ON, 'linux', 'copilot'],
    ['unknown', ON, 'darwin', 'someday-agent'],
  ])('refuses an agent that is %s', async (_case, flags, platform, type) => {
    await expect(caller(flags, platform).detect({ type })).resolves.toMatchObject({
      available: false,
    });
    await expect(caller(flags, platform).connect({ type })).rejects.toThrow();
    expect(rows()).toEqual([]);
  });

  it('finds and connects the GitHub Copilot CLI installed here, with no stored sign-in', async () => {
    env.FAKE_VERSION = '1.0.97';
    await expect(caller(COPILOT_ON).detect({ type: 'copilot' })).resolves.toEqual({
      available: true,
      version: '1.0.97',
    });
    await caller(COPILOT_ON).connect({ type: 'copilot' });
    expect(rows()).toEqual([
      expect.objectContaining({
        type: 'copilot',
        accountLabel: 'GitHub Copilot',
        source: 'copilot-passthrough',
        oauthToken: null,
      }),
    ]);
  });

  it('refuses a GitHub Copilot version Frink has not checked, in plain words', async () => {
    env.FAKE_VERSION = '1.1.0';
    const reason =
      "Frink has checked GitHub Copilot 1.0.96 and later 1.0 releases. You have 1.1.0, which Frink hasn't checked yet. To use GitHub Copilot in Frink now, go back to GitHub Copilot 1.0.";

    await expect(caller(COPILOT_ON).detect({ type: 'copilot' })).resolves.toEqual({
      available: false,
      reason,
    });
    await expect(caller(COPILOT_ON).connect({ type: 'copilot' })).rejects.toThrow(reason);
    expect(rows()).toEqual([]);
  });

  it('lists the models an agent offered in its last session, or none before it has run', async () => {
    await expect(caller().models({ type: 'opencode' })).resolves.toEqual([
      { id: 'opencode/big-pickle', name: 'Big Pickle' },
    ]);
    await expect(caller().models({ type: 'grok' })).resolves.toEqual([]);
  });

  it("lists GitHub Copilot's models from its own last session", async () => {
    await expect(caller().models({ type: 'copilot' })).resolves.toEqual(COPILOT_MODELS);
  });

  it('finds the OpenAI login Codex keeps on this computer', async () => {
    await expect(caller(CODEX_ON).detect({ type: 'codex' })).resolves.toEqual({
      available: true,
      email: 'me@openai.example',
      sourcePath: 'codex-passthrough://local',
    });
    detectCodex.mockResolvedValue({ available: false, hint: 'Run `codex login`.' });
    await expect(caller(CODEX_ON).detect({ type: 'codex' })).resolves.toEqual({
      available: false,
      reason: 'Run `codex login`.',
    });
  });

  it('connects one OpenAI login per device, labelled by the user, with no stored token', async () => {
    await caller(CODEX_ON).connect({ type: 'codex', accountLabel: 'My Codex' });
    const [connected] = rows();
    expect(connected).toMatchObject({
      type: 'codex',
      accountLabel: 'My Codex',
      oauthToken: null,
      source: 'codex-passthrough',
      sourcePath: 'codex-passthrough://local',
      expectedEmail: 'me@openai.example',
      isDefault: true,
    });

    detectCodex.mockResolvedValue({ available: true, displayName: 'OpenAI' });
    await expect(
      caller(CODEX_ON).connect({ type: 'codex', accountLabel: 'Renamed' }),
    ).resolves.toEqual({ accountId: connected?.id, status: 'updated' });
    expect(rows()).toEqual([
      expect.objectContaining({ accountLabel: 'Renamed', expectedEmail: null }),
    ]);
  });

  it('refuses an OpenAI connect when Codex has no login here', async () => {
    detectCodex.mockResolvedValue({ available: false });
    await expect(caller(CODEX_ON).connect({ type: 'codex', accountLabel: 'x' })).rejects.toThrow(
      /codex login/,
    );
    expect(rows()).toEqual([]);
  });
});
