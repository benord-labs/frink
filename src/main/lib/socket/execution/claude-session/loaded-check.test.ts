import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import log from 'electron-log';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { __resetStagedVsLoadedForTest } from '../../../provider/staged-vs-loaded';
import * as sentry from '../../../sentry/init';
import type { ClaudeSession } from '../../claude-session-registry';
import { expectLoaded, loadedFromInit, noteSessionFrame, stagedInConfigDir } from './loaded-check';

let root: string;
let configDir: string;
beforeEach(async () => {
  __resetStagedVsLoadedForTest();
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'loaded-check-'));
  configDir = path.join(root, 'config');
  await fs.promises.mkdir(path.join(configDir, 'skills'), { recursive: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.promises.rm(root, { recursive: true, force: true });
});

async function write(file: string, text: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, text);
}

const writeSkill = (name: string, frontmatter = '') =>
  write(path.join(configDir, 'skills', name, 'SKILL.md'), `---\n${frontmatter}\n---\n# ${name}`);

const enablePlugins = (dir: string, enabledPlugins: Record<string, boolean>) =>
  write(path.join(dir, 'settings.json'), JSON.stringify({ enabledPlugins }));

function spawned(projectRoot?: string): ClaudeSession {
  // SAFETY: noteSessionFrame reads only subChatId and the session's identity.
  const session = { subChatId: 'chat-1' } as ClaudeSession;
  expectLoaded(session, { configDir, projectRoot, agents: [], mcpServers: [] });
  return session;
}

type InitFields = Parameters<typeof loadedFromInit>[0];
// SAFETY: the check reads only these fields of an init frame.
const init = (fields: InitFields) => ({ type: 'system', subtype: 'init', ...fields }) as SDKMessage;
// SAFETY: the session reader passes any other frame straight on.
const ASSISTANT = { type: 'assistant' } as SDKMessage;

/** Waits for the one report a session sends, and returns its message. */
async function reported(capture: MockInstance<typeof sentry.captureMainMessage>) {
  await vi.waitFor(() => expect(capture.mock.calls).toHaveLength(1));
  return capture.mock.calls[0]?.[0];
}

describe('stagedInConfigDir', () => {
  it('reads the enabled plugins and the skill folders', async () => {
    await enablePlugins(configDir, { 'a@m': true, 'b@m': false });
    await writeSkill('review');
    expect(await stagedInConfigDir(configDir)).toEqual({ plugins: ['a@m'], skills: ['review'] });
  });

  it('has no plugins without a settings file, and rejects one it cannot parse', async () => {
    expect(await stagedInConfigDir(configDir)).toEqual({ plugins: [], skills: [] });
    await write(path.join(configDir, 'settings.json'), '# not json');
    await expect(stagedInConfigDir(configDir)).rejects.toThrow(SyntaxError);
  });
});

describe('loadedFromInit', () => {
  it('reads servers by name, skills from both lists and plugins by source', () => {
    const plugins = [{ name: 'Notion', path: '/p', source: 'notion@m' }];
    const mcp_servers = [{ name: 'linear', status: 'failed' }];
    expect(loadedFromInit({ skills: ['a'], slash_commands: ['b'], plugins, mcp_servers })).toEqual({
      mcpServers: ['linear'],
      skills: ['a', 'b'],
      plugins: ['notion@m'],
    });
  });

  it('leaves out plugins when any entry lacks a source, and every category of a bare init', () => {
    const plugins = [{ name: 'a', source: 'a@m' }, { name: 'b' }];
    expect(loadedFromInit({ plugins }).plugins).toBeUndefined();
    expect(loadedFromInit({})).toEqual({});
  });
});

describe('noteSessionFrame', () => {
  it('checks the first init only, after any other frame', async () => {
    const capture = vi.spyOn(sentry, 'captureMainMessage');
    const warn = vi.spyOn(log, 'warn');
    await writeSkill('review');
    const session = spawned();
    noteSessionFrame(session, ASSISTANT);
    noteSessionFrame(session, init({ skills: [] }));
    noteSessionFrame(session, init({ skills: [] }));
    expect(await reported(capture)).toBe('claude loaded less than Frink staged (skills: review)');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a session it took no snapshot of', async () => {
    const capture = vi.spyOn(sentry, 'captureMainMessage');
    // SAFETY: noteSessionFrame reads only subChatId and the session's identity.
    noteSessionFrame({ subChatId: 'chat-2' } as ClaudeSession, init({ skills: [] }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(capture).not.toHaveBeenCalled();
  });

  it('captures a failed snapshot once, with no init and no unhandled rejection', async () => {
    const capture = vi.spyOn(sentry, 'captureMainException');
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    await write(path.join(configDir, 'settings.json'), '# not json');
    spawned();
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off('unhandledRejection', unhandled);
    expect(capture).toHaveBeenCalledWith(expect.any(SyntaxError), {
      surface: 'provider-staged-vs-loaded',
    });
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('does not report a skill its SKILL.md hides from users', async () => {
    const capture = vi.spyOn(sentry, 'captureMainMessage');
    const hidden = ['false', 'no', 'off', 'n', '"false"', '0'];
    for (const [index, value] of hidden.entries()) {
      await writeSkill(`hidden-${index}`, `user-invocable: ${value}`);
    }
    await writeSkill('plain', 'description: shown');
    await writeSkill('unparsable', 'user-invocable: [');
    noteSessionFrame(spawned(), init({ skills: [], slash_commands: [] }));
    expect(await reported(capture)).toBe(
      'claude loaded less than Frink staged (skills: plain, unparsable)',
    );
  });

  it('captures an init it cannot read instead of throwing into the reader', async () => {
    const capture = vi.spyOn(sentry, 'captureMainException');
    // SAFETY: a malformed init from a CLI whose format changed.
    const malformed = { type: 'system', subtype: 'init', mcp_servers: {} } as SDKMessage;
    expect(() => noteSessionFrame(spawned(), malformed)).not.toThrow();
    await vi.waitFor(() =>
      expect(capture).toHaveBeenCalledWith(expect.any(TypeError), {
        surface: 'provider-staged-vs-loaded',
      }),
    );
  });

  it("does not report a plugin or skill the project's settings turn off", async () => {
    const capture = vi.spyOn(sentry, 'captureMainMessage');
    const project = path.join(root, 'project');
    await enablePlugins(configDir, { 'off@m': true, 'on@m': true });
    await enablePlugins(path.join(project, '.claude'), { 'off@m': false });
    const overrides = JSON.stringify({ skillOverrides: { overridden: 'off' } });
    await write(path.join(project, '.claude', 'settings.local.json'), overrides);
    await writeSkill('overridden');
    await writeSkill('plain');
    noteSessionFrame(spawned(project), init({ skills: [], plugins: [] }));
    expect(await reported(capture)).toBe(
      'claude loaded less than Frink staged (plugins: on@m; skills: plain)',
    );
  });
});
