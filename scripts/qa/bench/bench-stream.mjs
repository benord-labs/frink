// bench-stream.mjs [deltas=5000] [outputs=20] [outputKB=100] — synthetic turn through the renderer's own @ai-sdk/react Chat; prints wall time and JS-heap delta (quota-free, deterministic).
import { connectPage, stamp } from './cdp.mjs';

const [deltas = 5000, outputs = 20, outputKb = 100] = process.argv.slice(2).map(Number);
const page = await connectPage(undefined, { renderer: 'vite' }); // imports Vite-served modules below
stamp(`bench on ${page.url}: deltas=${deltas} outputs=${outputs} outputKB=${outputKb}`);
const result = await page.evaluate(`(async () => {
  const { Chat } = await import('/@id/@ai-sdk/react');
  const big = 'x'.repeat(${outputKb} * 1024);
  const chunks = [{ type: 'start', messageId: 'bench-m1' }, { type: 'start-step' }];
  for (let i = 0; i < ${outputs}; i++) {
    const toolCallId = 'call-' + i;
    chunks.push(
      { type: 'tool-input-start', toolCallId, toolName: 'Read' },
      { type: 'tool-input-available', toolCallId, toolName: 'Read', input: { file_path: 'f' + i } },
      { type: 'tool-output-available', toolCallId, output: { content: big + i } },
    );
  }
  chunks.push({ type: 'text-start', id: 't1' });
  for (let i = 0; i < ${deltas}; i++) chunks.push({ type: 'text-delta', id: 't1', delta: 'lorem ' });
  chunks.push({ type: 'text-end', id: 't1' }, { type: 'finish-step' }, { type: 'finish' });
  const transport = {
    sendMessages: async () => new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(ch); c.close(); } }),
    reconnectToStream: async () => null,
  };
  const chat = new Chat({ id: 'bench-' + Date.now(), transport, messages: [] });
  const heap0 = performance.memory?.usedJSHeapSize ?? -1;
  const t0 = performance.now();
  await chat.sendMessage({ text: 'go' });
  for (let i = 0; i < 6000 && chat.status !== 'ready' && chat.status !== 'error'; i++) await new Promise((r) => setTimeout(r, 100));
  const last = chat.messages.at(-1);
  return {
    status: chat.status,
    error: chat.error ? String(chat.error).slice(0, 200) : null,
    ms: Math.round(performance.now() - t0),
    parts: last?.parts?.length,
    messageBytes: JSON.stringify(last).length,
    jsHeapMbBefore: Math.round(heap0 / 1048576),
    jsHeapMbAfter: Math.round((performance.memory?.usedJSHeapSize ?? -1) / 1048576),
    jsHeapDeltaMb: Math.round(((performance.memory?.usedJSHeapSize ?? 0) - Math.max(heap0, 0)) / 1048576),
  };
})()`);
stamp('result ' + JSON.stringify(result));
page.close();
// A run that never settled (timeout or transport error) is not a measurement; say so in the exit code.
if (result.status !== 'ready') { console.error(`bench did not settle: status=${result.status} error=${result.error}`); process.exit(5); }
