import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import log from 'electron-log';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../../db/schema';
import { freshDb, type TestDb } from '../../../db/test-utils/fresh-db';
import * as storeLocal from '../../../permissions/v2/store-local';
import { makeLocalChat } from '../../../trpc/routers/chats/test-factories';
import { loadLinkedRoots } from './linked-roots';

// Made in beforeAll, so a run that filters out every case leaves no folder behind.
let root = '';
// Link order is b, gone, inner, outer, a; the chat's own folder is main.
const FOLDERS = {
  main: 'outer/main',
  b: 'b',
  gone: 'never-created',
  inner: 'outer/main/inner',
  outer: 'outer',
  a: 'a',
} as const;
const dir = (id: keyof typeof FOLDERS) => path.join(root, FOLDERS[id]);
beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'linked-roots-')));
  for (const id of ['inner', 'a', 'b'] as const) fs.mkdirSync(dir(id), { recursive: true });
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const none = { allow: [], deny: [], ask: [] };
let db: TestDb;

beforeEach(() => {
  db = freshDb();
  for (const [id, folder] of Object.entries(FOLDERS)) {
    db.insert(schema.projects)
      .values({ id, name: id, path: path.join(root, folder) })
      .run();
  }
  db.insert(schema.chats)
    .values(makeLocalChat({ id: 'c1', projectId: 'main' }))
    .run();
  // Written straight to the table: the repo refuses these links, but a folder can go missing,
  // or a link can come to overlap the chat's folder, after the link is made.
  const links = Object.keys(FOLDERS).filter((id) => id !== 'main');
  db.insert(schema.chatLinkedProjects)
    .values(links.map((projectId) => ({ chatId: 'c1', projectId })))
    .run();
  db.insert(schema.projectPermissionRules)
    .values({ projectId: 'a', ruleString: 'Read(secrets/**)', ruleType: 'deny' })
    .run();
});
afterEach(() => vi.restoreAllMocks());

describe('loadLinkedRoots', () => {
  it("keeps link order with each project's rules, leaving out gone and overlapping folders", async () => {
    expect(await loadLinkedRoots(db, 'c1', dir('main'))).toEqual([
      { projectId: 'b', path: dir('b'), doc: none },
      { projectId: 'a', path: dir('a'), doc: { ...none, deny: ['Read(secrets/**)'] } },
    ]);
  });

  it('gives only the project whose rules fail to load a null doc, so its reads ask', async () => {
    const warn = vi.spyOn(log, 'warn');
    const real = storeLocal.getProjectDoc;
    vi.spyOn(storeLocal, 'getProjectDoc').mockImplementation(async (handle, id) => {
      if (id === 'b') throw new Error('SQLITE_CORRUPT');
      return real(handle, id);
    });
    const roots = await loadLinkedRoots(db, 'c1', dir('main'));
    expect(roots.map(({ projectId, doc }) => [projectId, doc?.deny ?? null])).toEqual([
      ['b', null],
      ['a', ['Read(secrets/**)']],
    ]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('gives no links, with a warning, when the links cannot be read', async () => {
    const warn = vi.spyOn(log, 'warn');
    db.run(sql`DROP TABLE chat_linked_projects`);
    expect(await loadLinkedRoots(db, 'c1', dir('main'))).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });
});
