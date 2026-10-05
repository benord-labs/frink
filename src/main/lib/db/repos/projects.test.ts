import { beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../schema';
import { freshDb, type TestDb } from '../test-utils/fresh-db';
import { listProjectsByRecentActivity, listRealProjects } from './projects';

let db: TestDb;
const at = (iso: string) => new Date(iso);

const seedProject = (id: string, createdAt: Date) =>
  db
    .insert(schema.projects)
    .values({ id, name: id, path: `/repos/${id}`, createdAt, updatedAt: createdAt });

const seedChat = (id: string, projectId: string, updatedAt: Date) =>
  db.insert(schema.chats).values({ id, projectId, updatedAt });

const seedSubChat = (id: string, chatId: string, updatedAt: Date) =>
  db.insert(schema.subChats).values({ id, chatId, updatedAt });

describe('listProjectsByRecentActivity', () => {
  beforeEach(() => {
    db = freshDb();
  });

  it('orders projects by their latest chat activity and exposes it as lastActiveAt', async () => {
    await seedProject('old', at('2026-01-01T00:00:00.000Z'));
    await seedProject('busy', at('2026-01-01T00:00:00.000Z'));
    await seedChat('c-old', 'old', at('2026-01-01T00:00:00.000Z'));
    await seedChat('c-busy', 'busy', at('2026-01-01T00:00:00.000Z'));
    await seedSubChat('s-old', 'c-old', at('2026-02-01T00:00:00.000Z'));
    await seedSubChat('s-busy-1', 'c-busy', at('2026-02-02T00:00:00.000Z'));
    await seedSubChat('s-busy-2', 'c-busy', at('2026-03-01T00:00:00.000Z'));

    const rows = await listProjectsByRecentActivity(db);

    expect(rows.map((r) => r.id)).toEqual(['busy', 'old']);
    expect(rows[0].lastActiveAt).toEqual(at('2026-03-01T00:00:00.000Z'));
  });

  it('ignores chat-row timestamps, which archiving also moves', async () => {
    await seedProject('active', at('2026-01-01T00:00:00.000Z'));
    await seedProject('archived', at('2026-01-01T00:00:00.000Z'));
    await seedChat('c-m', 'active', at('2026-01-01T00:00:00.000Z'));
    await seedSubChat('s-m', 'c-m', at('2026-02-01T00:00:00.000Z'));
    await seedChat('c-a', 'archived', at('2026-06-01T00:00:00.000Z'));
    await seedSubChat('s-a', 'c-a', at('2026-01-15T00:00:00.000Z'));

    const rows = await listProjectsByRecentActivity(db);

    expect(rows.map((r) => r.id)).toEqual(['active', 'archived']);
  });

  it('sorts projects with no chat activity by when they were added and leaves lastActiveAt null', async () => {
    await seedProject('used', at('2026-01-01T00:00:00.000Z'));
    await seedChat('c-u', 'used', at('2026-01-01T00:00:00.000Z'));
    await seedSubChat('s-u', 'c-u', at('2026-05-01T00:00:00.000Z'));
    await seedProject('added-early', at('2026-02-01T00:00:00.000Z'));
    await seedProject('added-late', at('2026-06-01T00:00:00.000Z'));

    const rows = await listProjectsByRecentActivity(db);

    expect(rows.map((r) => r.id)).toEqual(['added-late', 'used', 'added-early']);
    expect(rows.find((r) => r.id === 'added-late')?.lastActiveAt).toBeNull();
  });
});

describe('listRealProjects', () => {
  beforeEach(() => {
    db = freshDb();
  });

  it('excludes virtual folders and keeps newest-updated first', async () => {
    await seedProject('older', at('2026-01-01T00:00:00.000Z'));
    await seedProject('newer', at('2026-02-01T00:00:00.000Z'));
    await db.insert(schema.projects).values({
      id: 'folder',
      name: 'Work',
      path: 'virtual://folders/123-work',
      createdAt: at('2026-03-01T00:00:00.000Z'),
      updatedAt: at('2026-03-01T00:00:00.000Z'),
    });

    const rows = await listRealProjects(db);

    expect(rows.map((r) => r.id)).toEqual(['newer', 'older']);
  });

  it('keeps a real project whose path merely contains the virtual prefix', async () => {
    await db.insert(schema.projects).values({
      id: 'nested',
      name: 'nested',
      path: '/repos/virtual://folders/not-a-folder',
      createdAt: at('2026-01-01T00:00:00.000Z'),
      updatedAt: at('2026-01-01T00:00:00.000Z'),
    });

    const rows = await listRealProjects(db);

    expect(rows.map((r) => r.id)).toEqual(['nested']);
  });
});
