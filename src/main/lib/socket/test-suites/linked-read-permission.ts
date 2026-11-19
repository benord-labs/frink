import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDatabase } from '../../db';
import { linkProjectToChat, unlinkProjectFromChat } from '../../db/repos/chat-linked-projects';
import { getProjectById, getProjectByPath } from '../../db/repos/projects';
import * as schema from '../../db/schema';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';
import { checkPermission } from '../../permissions/v2/check';
import { resolveScopes } from '../../permissions/v2/scope-resolver';
import { makeLocalChat } from '../../trpc/routers/chats/test-factories';
import * as socketClient from '../client';
import { validateToolPermission } from '../streaming/pending-permission/validate-tool-permission';
import type { ExecutorPermissionHarness } from './executor-codex-permissions';

type ActualCheck = typeof import('../../permissions/v2/check');
type ActualProjects = typeof import('../../db/repos/projects');

const CARD = { allowed: false, message: 'User denied permission' };
const SAFETY = { allowed: false, message: expect.stringContaining('safety policy') };
const NO_RULES = { allow: [], deny: [], ask: [] };

/** Lets the gate read a linked project's name from the suite's database, as it does in the app.
 * Returns what puts the harness's own lookup back. */
async function readProjectNamesFromDb(): Promise<() => void> {
  const lookup = vi.mocked(getProjectById);
  const harness = lookup.getMockImplementation();
  lookup.mockImplementation(
    (await vi.importActual<ActualProjects>('../../db/repos/projects')).getProjectById,
  );
  return () => {
    if (harness) lookup.mockImplementation(harness);
  };
}

/** The gate end to end on a real database and folder tree: links and rules come from the
 * repos, and the rules are the real ones. Only the chat's project lookup and the card stay mocked;
 * a linked project's name is read from the database. */
export function registerLinkedReadPermissionTests({
  clientPermissionBridge,
}: Pick<ExecutorPermissionHarness, 'clientPermissionBridge'>): void {
  describe('validateToolPermission — projects linked to the chat', () => {
    // Made in beforeAll, so a run that filters out every case here leaves no folder behind.
    let root = '';
    const main = () => path.join(root, 'main');
    const at = (rel: string) => path.join(root, 'lib', rel);
    const projectLookup = vi.mocked(getProjectByPath);
    let db: TestDb;
    let actual: ActualCheck;
    let harnessDb: (() => ReturnType<typeof getDatabase>) | undefined;
    let harnessLookup: ReturnType<typeof projectLookup.getMockImplementation>;
    let restoreNames = () => {};

    const gate = (
      tool: string,
      input: Record<string, unknown>,
      { chatId = 'c1', deferAskToProvider = false } = {},
    ) =>
      validateToolPermission(
        tool,
        input,
        main(),
        chatId,
        's1',
        undefined,
        undefined,
        false,
        deferAskToProvider,
      );
    const read = (rel: string, chatId?: string) => gate('Read', { file_path: at(rel) }, { chatId });
    const userReadRule = (ruleType: 'deny' | 'ask') => () =>
      db.insert(schema.userPermissionRules).values({ ruleString: 'Read', ruleType }).run();
    const linkedTo = (...links: Array<{ projectId: string; path: string }>) =>
      expect.objectContaining({ linkedRoots: links.map((link) => ({ ...link, doc: NO_RULES })) });

    // Earlier cases leave fs stubs in place (mkdirSync, existsSync, ...); this suite needs the disk.
    beforeAll(() => {
      vi.restoreAllMocks();
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'linked-read-gate-')));
      const files = ['main/inner/a.ts', 'wt/a.ts', 'lib/src/a.ts', 'lib/.env', 'lib/secrets/x'];
      for (const file of [...files, 'out/b.txt']) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), 'x');
      }
      fs.symlinkSync(path.join(root, 'out/b.txt'), at('escape'));
    });
    afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

    beforeEach(async () => {
      harnessDb = vi.mocked(getDatabase).getMockImplementation();
      harnessLookup = projectLookup.getMockImplementation();
      vi.restoreAllMocks();
      vi.mocked(checkPermission).mockClear();
      db = freshDb();
      for (const id of ['main', 'lib']) {
        db.insert(schema.projects)
          .values({ id, name: id, path: path.join(root, id) })
          .run();
      }
      // c2 is another chat in the same project, with no links of its own.
      for (const id of ['c1', 'c2']) {
        db.insert(schema.chats)
          .values(makeLocalChat({ id, projectId: 'main' }))
          .run();
      }
      expect(linkProjectToChat(db, 'c1', 'lib')).toEqual({ ok: true });

      vi.mocked(getDatabase).mockImplementation(
        () => db as unknown as ReturnType<typeof getDatabase>,
      );
      projectLookup.mockResolvedValue({ id: 'main', name: 'main', path: main() } as never);
      restoreNames = await readProjectNamesFromDb();
      actual = await vi.importActual<ActualCheck>('../../permissions/v2/check');
      actual.setDocsLoader((req) => resolveScopes(db, req));
      vi.mocked(checkPermission).mockImplementation(actual.checkPermission);
      vi.mocked(socketClient.sendPermissionRequest).mockImplementation((payload) =>
        clientPermissionBridge.lastResponseHandler?.({ ...payload, approved: false }),
      );
    });
    afterEach(() => {
      actual.resetDocsLoader();
      if (harnessDb) vi.mocked(getDatabase).mockImplementation(harnessDb);
      if (harnessLookup) projectLookup.mockImplementation(harnessLookup);
      restoreNames();
    });

    it.each<[string, () => Record<string, unknown>]>([
      ['Read', () => ({ file_path: at('src/a.ts') })],
      ['Glob', () => ({ pattern: '**/*.ts', path: at('') })],
      ['Grep', () => ({ pattern: 'x', path: at('src') })],
    ])('lets a %s inside a linked project run with no card', async (tool, input) => {
      expect(await gate(tool, input())).toEqual({ allowed: true });
      expect(socketClient.sendPermissionRequest).not.toHaveBeenCalled();
      expect(checkPermission).toHaveBeenLastCalledWith(
        linkedTo({ projectId: 'lib', path: at('') }),
      );
    });

    it('asks in another chat of the same project, which has no links', async () => {
      expect(await read('src/a.ts', 'c2')).toEqual(CARD);
      expect(checkPermission).toHaveBeenLastCalledWith(linkedTo());
    });

    it('asks on the very next read once the project is unlinked', async () => {
      expect(await read('src/a.ts')).toEqual({ allowed: true });
      unlinkProjectFromChat(db, 'c1', 'lib');
      expect(await read('src/a.ts')).toEqual(CARD);
    });

    it.each<[string, string, () => void, object]>([
      ['keeps the env file on the deny list', '.env', () => {}, SAFETY],
      [
        'denies by a rule saved on the linked project',
        'secrets/x',
        () =>
          db
            .insert(schema.projectPermissionRules)
            .values({ projectId: 'lib', ruleString: 'Read(secrets/**)', ruleType: 'deny' })
            .run(),
        { allowed: false, message: 'Denied by rule Read(secrets/**) saved on linked project lib' },
      ],
      [
        'denies by a user rule, which runs before the link',
        'src/a.ts',
        userReadRule('deny'),
        { allowed: false, message: 'Denied by user-tier rule Read' },
      ],
      [
        'asks by a user ask rule, which runs before the link',
        'src/a.ts',
        userReadRule('ask'),
        CARD,
      ],
      ['asks for a symlink that leads out of the linked folder', 'escape', () => {}, CARD],
      [
        'asks, rather than denies, when the links cannot be read',
        'src/a.ts',
        () => db.run(sql`DROP TABLE chat_linked_projects`),
        CARD,
      ],
    ])('%s', async (_, rel, setup, expected) => {
      setup();
      expect(await read(rel)).toEqual(expected);
    });

    it('names the linked project whose own ask rule asks, on the card', async () => {
      db.insert(schema.projectPermissionRules)
        .values({ projectId: 'lib', ruleString: 'Read(secrets/**)', ruleType: 'ask' })
        .run();
      expect(await read('secrets/x')).toEqual(CARD);
      expect(socketClient.sendPermissionRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.objectContaining({ matchedProjectId: 'lib', matchedProjectName: 'lib' }),
        }),
      );
    });

    it.each([
      ['an env file', '.env'],
      ['key files', '**/*.key'],
    ])('denies a Grep of a linked project filtered to %s', async (_, glob) => {
      expect(await gate('Grep', { pattern: 'x', path: at(''), glob })).toEqual(SAFETY);
    });

    it('lets a linked read skip Auto review, and leaves a linked edit as it is today', async () => {
      const file = { file_path: at('src/a.ts') };
      expect(await gate('Read', file, { deferAskToProvider: true })).toEqual({ allowed: true });
      expect(await gate('Edit', file, { deferAskToProvider: true })).toEqual({ allowed: null });
      expect(await gate('Edit', file)).toEqual(CARD);
      expect(socketClient.sendPermissionRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.objectContaining({ pathLocation: 'outside' }),
        }),
      );
    });

    // A worktree chat's gate is judged against the main checkout, as resolvePermissionProjectPath
    // gives it, so a link inside that checkout is left out there too.
    it("applies a worktree chat's links, leaving out one inside the main checkout", async () => {
      const worktreePath = path.join(root, 'wt');
      db.insert(schema.chats)
        .values(makeLocalChat({ id: 'c3', projectId: 'main', worktreePath }))
        .run();
      expect(linkProjectToChat(db, 'c3', 'lib')).toEqual({ ok: true });
      // The repo refuses this link; one can still come to sit there after it is made.
      db.insert(schema.projects)
        .values({ id: 'inner', name: 'inner', path: path.join(main(), 'inner') })
        .run();
      db.insert(schema.chatLinkedProjects).values({ chatId: 'c3', projectId: 'inner' }).run();
      expect(await read('src/a.ts', 'c3')).toEqual({ allowed: true });
      expect(checkPermission).toHaveBeenLastCalledWith(
        linkedTo({ projectId: 'lib', path: at('') }),
      );
    });
  });
}
