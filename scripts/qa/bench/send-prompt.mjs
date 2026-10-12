// send-prompt.mjs <prompt-file> [chatId=qa-fixture-chat-seeded] [subChatId=qa-fixture-subchat-1] — reloads, opens the chat, types into the real composer, sends, waits until a new message is persisted and streaming has stopped. The rig answers with the scripted fake by default; boot with QA_REAL_CLAUDE=1 for a real turn on this machine's Claude login (spends its quota).
import { readFileSync } from 'node:fs';
import { connectPage, sleep, stamp } from './cdp.mjs';

const [promptFile, chatId = 'qa-fixture-chat-seeded', subChatId = 'qa-fixture-subchat-1'] = process.argv.slice(2);
if (!promptFile) { console.error('usage: send-prompt.mjs <prompt-file> [chatId] [subChatId]'); process.exit(2); }
const prompt = readFileSync(promptFile, 'utf8').trim();
const page = await connectPage(undefined, { renderer: 'vite' }); // imports Vite-served modules below
await page.call('Page.enable');
// The renderer caches a failed account resolution (a signed-out machine, since signed in); a reload clears it.
await page.call('Page.reload');
await sleep(45_000);
const selected = await page.evaluate(`(async () => {
  const { appStore } = await import('/lib/jotai-store.ts');
  const { selectedAgentChatIdAtom } = await import('/features/agents/atoms/index.ts');
  appStore.set(selectedAgentChatIdAtom, ${JSON.stringify(chatId)});
  return String(appStore.get(selectedAgentChatIdAtom));
})()`);
stamp(`selected chat ${selected}`);
await sleep(8_000);
const COMPOSER = `document.querySelector('[role="textbox"][contenteditable="true"]')`;
if ((await page.evaluate(`${COMPOSER} ? (${COMPOSER}.focus(), 'ok') : 'none'`)) !== 'ok') { stamp('composer not found'); process.exit(3); }
await page.call('Input.insertText', { text: prompt });
await sleep(1500);
// A CDP key event never reaches the editor's React onKeyDown; a bubbling synthetic keydown does.
await page.evaluate(`${COMPOSER}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }))`);
await sleep(2000);
if ((await page.evaluate(`${COMPOSER}.innerText.length`)) > 0) { stamp('send did not clear the composer'); process.exit(4); }
const t0 = Date.now();
stamp('sent');
// Settled = the reply row is persisted AND the status store no longer reports streaming; the persisted
// count catches a run that finishes between two polls, which a streaming-only watch would miss.
const PERSISTED = `(async () => {
  const { trpcClient } = await import('/lib/trpc.ts');
  const r = await trpcClient.chats.getSubChatMessages.query({ subChatId: ${JSON.stringify(subChatId)} });
  return (Array.isArray(r) ? r : r.messages ?? []).length;
})()`;
const STATUS = `(async () => {
  const { useStreamingStatusStore } = await import('/features/agents/stores/streaming-status-store.ts');
  const m = useStreamingStatusStore.getState().statuses;
  return JSON.stringify(m instanceof Map ? Object.fromEntries(m) : m);
})()`;
const persistedBefore = await page.evaluate(PERSISTED);
for (;;) {
  await sleep(5_000);
  const [persisted, statuses] = await Promise.all([page.evaluate(PERSISTED), page.evaluate(STATUS)]);
  stamp(`t+${Math.round((Date.now() - t0) / 1000)}s persisted=${persisted} ${statuses}`);
  if (persisted > persistedBefore && !/streaming/.test(statuses)) { stamp('run finished'); break; }
  if (Date.now() - t0 > 40 * 60_000) { page.close(); console.error(`run did not settle within 40 min (persisted ${persistedBefore} -> ${persisted})`); process.exit(5); }
}
page.close();
