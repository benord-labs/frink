import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ErrorCodes, ResponseError } from 'vscode-jsonrpc/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetStagedVsLoadedForTest,
  STAGED_VS_LOADED_SURFACE,
} from '../../../provider/staged-vs-loaded';
import * as sentry from '../../../sentry/init';
import type { CodexAppServerClient } from '../app-server-client';
import {
  _resetCodexSkillRootsRpcOutcomeForTests,
  recordCodexSkillRootsRpcOutcome,
} from '../skill-roots';
import { type CodexStaged, checkCodexThreadLoaded } from './loaded-check';

let root: string;
let skillRoot: string;
beforeEach(async () => {
  __resetStagedVsLoadedForTest();
  _resetCodexSkillRootsRpcOutcomeForTests();
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-loaded-check-'));
  skillRoot = path.join(root, 'skills');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.promises.rm(root, { recursive: true, force: true });
});

type McpPage = { data: { name: string }[]; nextCursor: string | null };
type SkillsList = { data: { cwd: string; skills: { name: string; path: string }[] }[] };
type Replies = { mcp?: (cursor?: string) => McpPage; skills?: SkillsList; fail?: Error };

const servers = (...names: string[]): McpPage => ({
  data: names.map((name) => ({ name })),
  nextCursor: null,
});

/** An app-server answering the two list calls, or failing every request. */
function appServer({ mcp = () => servers(), skills = { data: [] }, fail }: Replies) {
  const sendRequest = vi.fn(async (method: string, params?: { cursor?: string }) => {
    if (fail) throw fail;
    return method === 'skills/list' ? skills : mcp(params?.cursor);
  });
  // SAFETY: the check calls only sendRequest, and parses every reply it gets.
  const client = { sendRequest } as Pick<CodexAppServerClient, 'sendRequest'>;
  return { client, sendRequest };
}

const staged = (over: Partial<CodexStaged> = {}): CodexStaged => ({
  subChatId: 'chat-1',
  cwd: root,
  mcpServers: [],
  skillRoots: [],
  ...over,
});

async function writeSkill(folder: string): Promise<void> {
  await fs.promises.mkdir(path.join(skillRoot, folder), { recursive: true });
  await fs.promises.writeFile(path.join(skillRoot, folder, 'SKILL.md'), '---\nname: x\n---\n');
}

/** Codex lists a skill by its frontmatter name, at its canonical SKILL.md path. */
const listing = (...folders: string[]): SkillsList => ({
  data: [
    {
      cwd: root,
      skills: folders.map((folder) => ({
        name: `Fancy ${folder}`,
        path: path.join('/private', skillRoot, folder, 'SKILL.md'),
      })),
    },
  ],
});

const reportOf = (message: string) => [
  message,
  'warning',
  expect.objectContaining({
    surface: STAGED_VS_LOADED_SURFACE,
    runtime: 'codex',
    subChatId: 'chat-1',
  }),
  expect.any(Array),
];

describe('checkCodexThreadLoaded', () => {
  it('stays quiet when the thread lists every staged server and skill', async () => {
    await writeSkill('alpha');
    const capture = vi.spyOn(sentry, 'captureMainMessage');
    const { client } = appServer({
      mcp: () => servers('linear', 'extra'),
      skills: listing('alpha'),
    });
    await checkCodexThreadLoaded(
      client,
      'th1',
      staged({ mcpServers: ['linear'], skillRoots: [skillRoot] }),
    );
    expect(capture).not.toHaveBeenCalled();
  });

  it("reports a staged server missing from the thread's MCP list", async () => {
    const capture = vi.spyOn(sentry, 'captureMainMessage');
    const { client, sendRequest } = appServer({ mcp: () => servers('extra') });
    await checkCodexThreadLoaded(client, 'th1', staged({ mcpServers: ['linear'] }));
    expect(sendRequest).toHaveBeenCalledWith('mcpServerStatus/list', {
      threadId: 'th1',
      detail: 'toolsAndAuthOnly',
      cursor: undefined,
    });
    expect(capture.mock.calls).toEqual([
      reportOf('codex loaded less than Frink staged (mcpServers: linear)'),
    ]);
  });

  it('joins pages by cursor, and leaves servers out when the cursor outlasts ten pages', async () => {
    const capture = vi.spyOn(sentry, 'captureMainMessage');
    const paged = appServer({
      mcp: (cursor) => (cursor ? servers('linear') : { ...servers('extra'), nextCursor: 'p2' }),
    });
    await checkCodexThreadLoaded(paged.client, 'th1', staged({ mcpServers: ['linear'] }));
    expect(paged.sendRequest).toHaveBeenCalledTimes(2);
    const endless = appServer({ mcp: () => ({ ...servers(), nextCursor: 'more' }) });
    await checkCodexThreadLoaded(endless.client, 'th1', staged({ mcpServers: ['linear'] }));
    expect(endless.sendRequest).toHaveBeenCalledTimes(10);
    expect(capture).not.toHaveBeenCalled();
  });

  it('compares skills by folder, not by the name Codex lists', async () => {
    await Promise.all([writeSkill('alpha'), writeSkill('beta')]);
    const capture = vi.spyOn(sentry, 'captureMainMessage');
    const { client, sendRequest } = appServer({ skills: listing('beta') });
    await checkCodexThreadLoaded(client, 'th1', staged({ skillRoots: [skillRoot, skillRoot] }));
    expect(sendRequest).toHaveBeenCalledWith('skills/list', { cwds: [root] });
    expect(capture.mock.calls).toEqual([
      reportOf('codex loaded less than Frink staged (skills: alpha)'),
    ]);
  });

  it('sends nothing when nothing is staged, or registering the skill roots failed', async () => {
    await writeSkill('alpha');
    const { client, sendRequest } = appServer({});
    await checkCodexThreadLoaded(client, 'th1', staged());
    recordCodexSkillRootsRpcOutcome({ ok: false, error: 'unsupported' });
    await checkCodexThreadLoaded(client, 'th1', staged({ skillRoots: [skillRoot] }));
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it('captures a failed check once without throwing, unless the app-server went away', async () => {
    await writeSkill('alpha');
    const exception = vi.spyOn(sentry, 'captureMainException');
    const both = staged({ mcpServers: ['linear'], skillRoots: [skillRoot] });
    await checkCodexThreadLoaded(appServer({ fail: new Error('boom') }).client, 'th1', both);
    expect(exception.mock.calls).toEqual([
      [new Error('boom'), { surface: STAGED_VS_LOADED_SURFACE }],
    ]);
    const gone = new ResponseError(ErrorCodes.PendingResponseRejected, 'connection disposed');
    await checkCodexThreadLoaded(appServer({ fail: gone }).client, 'th1', both);
    expect(exception).toHaveBeenCalledTimes(1);
  });
});
