import type { seedFixtures } from '.';
import * as schema from '../../../src/main/lib/db/schema';

type FixtureDb = Parameters<typeof seedFixtures>[0];
const CREATED_AT = new Date('2026-01-01T10:00:00Z');
export const CODEX_FIXTURE = {
  accountId: 'qa-fixture-account-codex',
  projectId: 'qa-fixture-project-codex',
  chatId: 'qa-fixture-chat-codex',
  subChatId: 'qa-fixture-subchat-codex',
} as const;

/** A separate project keeps existing Claude scenarios on their original account. No turn runs. */
export function seedCodexFixture(db: FixtureDb, projectPath: string): void {
  db.insert(schema.claudeCodeCredentials)
    .values({
      id: CODEX_FIXTURE.accountId,
      type: 'codex',
      accountLabel: 'QA Codex',
      source: 'codex-passthrough',
      sourcePath: 'codex-passthrough://local',
      oauthToken: null,
      needsReauthAt: null,
      isDefault: false,
      connectedAt: CREATED_AT,
    })
    .run();
  db.insert(schema.projects)
    .values({
      id: CODEX_FIXTURE.projectId,
      name: 'QA Codex',
      path: `${projectPath}/scripts/qa`,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    })
    .run();
  db.insert(schema.projectAiAccounts)
    .values({
      projectId: CODEX_FIXTURE.projectId,
      accountId: CODEX_FIXTURE.accountId,
      createdAt: CREATED_AT,
    })
    .run();
  db.insert(schema.chats)
    .values({
      id: CODEX_FIXTURE.chatId,
      projectId: CODEX_FIXTURE.projectId,
      name: 'Codex model picker',
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    })
    .run();
  db.insert(schema.subChats)
    .values({
      id: CODEX_FIXTURE.subChatId,
      chatId: CODEX_FIXTURE.chatId,
      name: 'Codex model picker',
      mode: 'agent',
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    })
    .run();
}

/** Verify the routing links as well as rows, so a half-seed fails before a visual drive. */
export function verifyCodexFixture(db: FixtureDb): boolean {
  const account = db
    .select()
    .from(schema.claudeCodeCredentials)
    .all()
    .find((a) => a.id === CODEX_FIXTURE.accountId);
  const project = db
    .select()
    .from(schema.projects)
    .all()
    .find((p) => p.id === CODEX_FIXTURE.projectId);
  const assignment = db
    .select()
    .from(schema.projectAiAccounts)
    .all()
    .find((a) => a.projectId === CODEX_FIXTURE.projectId);
  const chat = db
    .select()
    .from(schema.chats)
    .all()
    .find((c) => c.id === CODEX_FIXTURE.chatId);
  const subChat = db
    .select()
    .from(schema.subChats)
    .all()
    .find((c) => c.id === CODEX_FIXTURE.subChatId);
  return (
    account?.type === 'codex' &&
    account.source === 'codex-passthrough' &&
    account.needsReauthAt === null &&
    account.oauthToken === null &&
    account.isDefault === false &&
    Boolean(project) &&
    assignment?.accountId === account.id &&
    chat?.projectId === project?.id &&
    subChat?.chatId === chat?.id
  );
}
