import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'new-chat-form.tsx'),
  'utf8',
);

// The login picked in the composer must reach chats.create and must not carry over to the next draft.
describe('new-chat-form account pick', () => {
  it('sends the picked login when creating the chat', () => {
    expect(src).toMatch(/createChatMutation\.mutate\(\{[\s\S]*?\baccountId: pickedAccountId,/);
  });

  it('clears the pick once the chat is created', () => {
    const onSuccess = src.match(/onSuccess: async \(data, variables\) => \{[\s\S]*?\n {4}\},/)?.[0];
    expect(onSuccess).toContain('newChatAccount.clearPick();');
  });
});
