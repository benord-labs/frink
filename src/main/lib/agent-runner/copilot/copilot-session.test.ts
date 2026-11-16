import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  ManagedSettingsResolvedData,
  PermissionMode,
  PermissionRequest,
  SessionConfig,
  SessionConfigBase,
  SessionEvent,
} from '@github/copilot-sdk';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  COPILOT_SESSION_OPTIONS,
  copilotSessionOptions,
  managedLayerProblem,
  openCheckedSession,
  prepareConfigDirectory,
} from './copilot-session';
import { CLIENT_ONLY_POLICY, fakeCopilotClient } from './copilot-test-fixtures';
import { COPILOT_TOOLS, createCopilotGate } from './index';

const VERSIONS = { floor: '1.0.96', below: '1.1.0' };
const SIGNED_OUT =
  "GitHub Copilot isn't signed in. Open Terminal, run `copilot login`, finish in your browser, then try again.";
const ENTERPRISE_SERVER =
  "Frink can't run GitHub Copilot for GitHub Enterprise Server accounts yet.";
const MANAGED =
  "Your organisation or device manages GitHub Copilot's settings, so Frink can't run it safely.";
const NOT_APPLIED =
  "GitHub Copilot didn't confirm Frink's safety settings, so Frink didn't start it.";
const NOT_MANUAL = 'GitHub Copilot started without asking before changes, so Frink stopped it.';
const NO_PLAN =
  "GitHub Copilot couldn't turn Plan mode on or off as asked, so Frink didn't send your message.";
const NEW_PROTOCOL =
  "This GitHub Copilot release talks to apps in a way Frink doesn't support yet.";
const versionText = (version: string) =>
  `Frink has checked GitHub Copilot CLI 1.0.96 and later 1.0 releases. You have ${version}.`;

const SAFETY_KEYS: (keyof SessionConfigBase)[] = [
  'workingDirectory',
  'configDirectory',
  'availableTools',
  'enableFileHooks',
  'enableConfigDiscovery',
  'remoteSession',
  'managedSettings',
  'hooks',
  'onPermissionRequest',
];

let root = '';
beforeAll(async () => {
  // A space in the path, as in macOS's Application Support folder.
  root = await mkdtemp(path.join(os.tmpdir(), 'copilot session '));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
afterEach(() => {
  vi.useRealTimers();
});

function sessionOptions(onEvent: (event: SessionEvent) => void = () => {}): SessionConfig {
  const gate = createCopilotGate({
    cwd: root,
    tools: COPILOT_TOOLS,
    checkApproval: async () => ({ allowed: true }),
    turnOver: new AbortController().signal,
  });
  return copilotSessionOptions({
    cwd: root,
    configDirectory: path.join(root, 'config'),
    tools: COPILOT_TOOLS,
    gate,
    onEvent,
  });
}

type FakeSetup = Parameters<typeof fakeCopilotClient>[0];

async function open(setup: FakeSetup, extra: { plan?: boolean; resumeSessionId?: string } = {}) {
  const fake = fakeCopilotClient(setup);
  const result = await openCheckedSession(fake.client, {
    options: sessionOptions(),
    plan: extra.plan ?? false,
    resumeSessionId: extra.resumeSessionId,
    versions: VERSIONS,
  });
  return { ...fake, result };
}

describe('copilotSessionOptions', () => {
  it("sets exactly the options routed as set by Frink, plus the runner's provider", () => {
    const routed = Object.entries(COPILOT_SESSION_OPTIONS)
      .filter(([, route]) => route === 'frink-sets')
      .map(([key]) => key)
      .sort();
    const set = Object.keys({ ...sessionOptions(), provider: undefined }).sort();
    expect(set).toEqual(routed);
  });

  it('routes every Copilot session option as set by Frink or left at a reviewed default', () => {
    for (const [option, route] of Object.entries(COPILOT_SESSION_OPTIONS)) {
      expect(['frink-sets', 'default-reviewed'], option).toContain(route);
    }
  });

  it('opens new and resumed sessions with the same safety options', async () => {
    const fake = fakeCopilotClient();
    const input = { options: sessionOptions(), plan: false, versions: VERSIONS };
    await openCheckedSession(fake.client, input);
    await openCheckedSession(fake.client, { ...input, resumeSessionId: 'earlier' });

    const [created, resumed] = fake.opened;
    expect(created?.how).toBe('create');
    expect(resumed?.how).toBe('resume');
    for (const key of SAFETY_KEYS) expect(resumed?.config[key]).toEqual(created?.config[key]);
    expect(created?.config).toMatchObject({
      workingDirectory: root,
      configDirectory: path.join(root, 'config'),
      availableTools: Object.keys(COPILOT_TOOLS),
      enableFileHooks: false,
      enableConfigDiscovery: false,
      remoteSession: 'off',
      managedSettings: {
        permissions: {
          disableBypassPermissionsMode: 'disable',
          disableAssistedPermissionsMode: true,
        },
      },
    });
  });

  it('never passes a token, a remote settings fetch or another model provider', () => {
    const options = sessionOptions();
    for (const key of ['gitHubToken', 'gitHubTokenProvider', 'enableManagedSettings', 'provider']) {
      expect(options).not.toHaveProperty(key);
    }
  });

  it("refuses every request that reaches Copilot's own permission check", async () => {
    const options = sessionOptions();
    const request: PermissionRequest = {
      kind: 'write',
      canOfferSessionApproval: false,
      fileName: 'a.txt',
      diff: '',
      intention: 'write',
    };
    expect(await options.onPermissionRequest?.(request, { sessionId: 's' })).toMatchObject({
      kind: 'reject',
    });
  });
});

describe('openCheckedSession', () => {
  it('opens a checked session and still passes every event on', async () => {
    const seen: string[] = [];
    const fake = fakeCopilotClient();
    const result = await openCheckedSession(fake.client, {
      options: sessionOptions((event) => seen.push(event.type)),
      plan: false,
      versions: VERSIONS,
    });
    expect(result).toEqual({ ok: true, session: fake.session, resumed: false });
    expect(seen).toEqual(['session.managed_settings_resolved']);
  });

  it('resumes the earlier session when it can', async () => {
    const { result, opened } = await open({}, { resumeSessionId: 'earlier' });
    expect(result).toMatchObject({ ok: true, resumed: true });
    expect(opened.map(({ how, sessionId }) => [how, sessionId])).toEqual([['resume', 'earlier']]);
  });

  it('starts a new session when the earlier one cannot be resumed', async () => {
    const { result, opened } = await open({ resumeFails: true }, { resumeSessionId: 'gone' });
    expect(result).toMatchObject({ ok: true, resumed: false });
    expect(opened.map(({ how }) => how)).toEqual(['resume', 'create']);
  });

  it('never opens a session while signed out', async () => {
    const { result, opened } = await open({ auth: { isAuthenticated: false } });
    expect(result).toEqual({ ok: false, reason: SIGNED_OUT });
    expect(opened).toEqual([]);
  });

  it.each(['https://github.example.com', 'https://github.com.example.com', 'http://github.com'])(
    'refuses an account on %s as GitHub Enterprise Server',
    async (host) => {
      const { result, opened } = await open({ auth: { isAuthenticated: true, host } });
      expect(result).toEqual({ ok: false, reason: ENTERPRISE_SERVER });
      expect(opened).toEqual([]);
    },
  );

  it.each(['https://github.com/', 'github.com', 'HTTPS://GitHub.com'])(
    'accepts a github.com account written as %s',
    async (host) => {
      const { result } = await open({ auth: { isAuthenticated: true, host } });
      expect(result).toMatchObject({ ok: true });
    },
  );

  it.each([
    ['an older release', '1.0.95', 3],
    ['the next minor release', '1.1.0', 3],
    ['an unreadable version', 'dev', 3],
  ])('refuses %s', async (_name, version, protocolVersion) => {
    const { result, opened } = await open({ status: { version, protocolVersion } });
    expect(result).toEqual({ ok: false, reason: versionText(version) });
    expect(opened).toEqual([]);
  });

  it('refuses a newer protocol without blaming the version', async () => {
    const { result, opened } = await open({ status: { version: '1.0.97', protocolVersion: 4 } });
    expect(result).toEqual({ ok: false, reason: NEW_PROTOCOL });
    expect(opened).toEqual([]);
  });

  it('accepts a later patch release of the checked minor', async () => {
    const { result } = await open({ status: { version: '1.0.120', protocolVersion: 3 } });
    expect(result).toMatchObject({ ok: true });
  });

  const managedCases: [string, Partial<ManagedSettingsResolvedData>, string][] = [
    ['server', { serverManaged: true, source: 'server' }, MANAGED],
    ['device', { deviceManaged: true, source: 'device' }, MANAGED],
    ['policy helper', { policyHelperManaged: true, source: 'policyHelper' }, MANAGED],
    ['bypass still on', { bypassPermissionsDisabled: false }, NOT_APPLIED],
    ['no client layer', { clientManaged: false }, NOT_APPLIED],
    ['an unreadable policy', { failClosed: true }, NOT_APPLIED],
    ['an unreported policy helper', { policyHelperManaged: undefined }, NOT_APPLIED],
  ];
  it.each(managedCases)('refuses a session managed by %s', async (_name, change, reason) => {
    const { result } = await open({ managed: { ...CLIENT_ONLY_POLICY, ...change } });
    expect(result).toEqual({ ok: false, reason });
  });

  it('refuses a session that never reports its managed settings', async () => {
    vi.useFakeTimers();
    const pending = open({ managed: null });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toMatchObject({ result: { ok: false, reason: NOT_APPLIED } });
  });

  it("does not let a failed resume's report vouch for the new session", async () => {
    vi.useFakeTimers();
    const pending = open({ resumeFails: true, managed: null }, { resumeSessionId: 'gone' });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toMatchObject({ result: { ok: false, reason: NOT_APPLIED } });
  });

  it('refuses a failing report that arrives after a passing one', async () => {
    const managedLater = { ...CLIENT_ONLY_POLICY, serverManaged: true };
    const { result } = await open({ managedLater });
    expect(result).toEqual({ ok: false, reason: MANAGED });
  });

  const unaskedModes: PermissionMode[] = ['assisted', 'allow-all'];
  it.each(unaskedModes)('refuses a session in %s mode', async (mode) => {
    const { result, disconnects } = await open({ permissionMode: mode });
    expect(result).toEqual({ ok: false, reason: NOT_MANUAL });
    expect(disconnects()).toBe(1);
  });

  it('switches to Plan mode when asked', async () => {
    const { result, session, disconnects } = await open({}, { plan: true });
    expect(result).toMatchObject({ ok: true });
    expect(disconnects()).toBe(0);
    await expect(session.rpc.mode.get()).resolves.toBe('plan');
  });

  it('turns Plan mode off on a resumed Plan session when not asked for', async () => {
    const { result, session } = await open({ mode: 'plan' }, { resumeSessionId: 'earlier' });
    expect(result).toMatchObject({ ok: true, resumed: true });
    await expect(session.rpc.mode.get()).resolves.toBe('interactive');
  });

  it('refuses the turn when Plan mode cannot be set', async () => {
    const { result, disconnects } = await open({ planFails: true }, { plan: true });
    expect(result).toEqual({ ok: false, reason: NO_PLAN });
    expect(disconnects()).toBe(1);
  });
});

describe('managedLayerProblem', () => {
  it("passes Frink's own policy alone", () => {
    expect(managedLayerProblem(CLIENT_ONLY_POLICY)).toBeUndefined();
  });
});

describe('prepareConfigDirectory', () => {
  it('creates a private folder', async () => {
    const dir = path.join(root, 'fresh', 'config');
    await prepareConfigDirectory(dir);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it('keeps only saved session state', async () => {
    const dir = path.join(root, 'used config');
    await mkdir(path.join(dir, 'session-state', 'abc'), { recursive: true });
    await mkdir(path.join(dir, 'hooks'), { recursive: true, mode: 0o755 });
    for (const file of [
      'session-state/abc/events.jsonl',
      'session-store.db',
      'session-store.db-wal',
      'config.json',
      'mcp-config.json',
      'permissions-config.json',
      'hooks/pre.json',
    ]) {
      await writeFile(path.join(dir, file), '{}');
    }
    await prepareConfigDirectory(dir);
    expect((await readdir(dir)).sort()).toEqual([
      'session-state',
      'session-store.db',
      'session-store.db-wal',
    ]);
    expect(await readdir(path.join(dir, 'session-state', 'abc'))).toEqual(['events.jsonl']);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });
});
