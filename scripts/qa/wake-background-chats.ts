// bun scripts/qa/wake-background-chats.ts — after boot.sh on a `use-fake-claude.sh` build, sends each
// seeded background-work chat its request through the app's own tRPC client (no UI driving). The fake
// CLI answers by starting the work, so every chat ends its turn holding a long test run, a Workflow or
// three commands. Session state lives in memory, so this runs after every boot.
import { BACKGROUND_WORK_CHATS } from './fixtures/background-work';
import { connectPage, sleep, stamp } from './bench/cdp.mjs';
import { FIXTURE_PROJECT_ID } from './fixtures';

const page = await connectPage();
for (let ready = false; !ready; await sleep(1000)) {
  ready = await page.evaluate('typeof window.trpc?.socket?.sendMessage?.mutate === "function"');
}
for (const chat of BACKGROUND_WORK_CHATS) {
  const input = {
    chatId: chat.chatId,
    subChatId: chat.subChatId,
    projectId: FIXTURE_PROJECT_ID,
    userMessage: {
      id: `${chat.subChatId}-request`,
      role: 'user',
      parts: [{ type: 'text', text: chat.request }],
    },
  };
  const result = await page.evaluate(
    `window.trpc.socket.sendMessage.mutate(${JSON.stringify(input)})`,
  );
  stamp(`${chat.name}: ${JSON.stringify(result)}`);
}
page.close();
