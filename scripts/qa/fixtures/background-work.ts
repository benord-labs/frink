/**
 * Chats that hold live background work once the QA app is up: a long test run, a Workflow, and three
 * parallel commands. Seeded empty like the others; `wake-background-chats.ts` then sends each its
 * `request`, which the scripted fake CLI (`fake-bin/`) answers by starting that work, with no model call.
 */
import type { seedFixtures } from '.';
import * as schema from '../../../src/main/lib/db/schema';

type FixtureDb = Parameters<typeof seedFixtures>[0];
const CREATED_AT = new Date('2026-01-01T12:30:00Z');

/** `request` is also what the fake CLI matches on, so the two must stay word for word. */
export const BACKGROUND_WORK_CHATS = [
  {
    chatId: 'qa-fixture-chat-bg-tests',
    subChatId: 'qa-fixture-subchat-bg-tests',
    name: 'Long-running tests',
    request: 'Run the full test suite in the background.',
  },
  {
    chatId: 'qa-fixture-chat-bg-workflow',
    subChatId: 'qa-fixture-subchat-bg-workflow',
    name: 'Review workflow',
    request: 'Start the review workflow in the background.',
  },
  {
    chatId: 'qa-fixture-chat-bg-commands',
    subChatId: 'qa-fixture-subchat-bg-commands',
    name: 'Tests, build watch and dev server',
    request: 'Start the tests, build watch and dev server in the background.',
  },
] as const;

/** `accountId` binds each chat to the fixture's Claude login: a chat with no login refuses to send. */
export function seedBackgroundWorkFixture(
  db: FixtureDb,
  projectId: string,
  accountId: string,
): void {
  for (const chat of BACKGROUND_WORK_CHATS) {
    const at = { createdAt: CREATED_AT, updatedAt: CREATED_AT };
    db.insert(schema.chats)
      .values({ id: chat.chatId, name: chat.name, projectId, accountId, ...at })
      .run();
    db.insert(schema.subChats)
      .values({ id: chat.subChatId, name: chat.name, chatId: chat.chatId, mode: 'agent', ...at })
      .run();
  }
}
