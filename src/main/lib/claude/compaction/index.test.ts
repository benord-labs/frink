import { readUIMessageStream, type UIMessageChunk as SdkChunk } from 'ai';
import { describe, expect, it } from 'vitest';
import type { UIMessageChunk } from '../types';
import { createCompactionMapper } from './index';

/**
 * Feeds chunks through the same AI SDK stream reader the renderer uses and returns the resulting
 * message parts. The SDK only materialises a part for chunks it recognises, so this is the check
 * that a chunk actually reaches the transcript rather than being dropped mid-stream.
 */
async function partsFor(chunks: UIMessageChunk[]) {
  const framed = [
    { type: 'start' },
    { type: 'start-step' },
    ...chunks,
    { type: 'finish-step' },
    { type: 'finish' },
  ];
  const stream = new ReadableStream<SdkChunk>({
    start(controller) {
      for (const chunk of framed) {
        // SAFETY: each literal above is a member of the SDK's wider chunk union; an unrecognised
        // one would produce no part at all and fail the assertions below.
        controller.enqueue(chunk as SdkChunk);
      }
      controller.close();
    },
  });

  let last;
  for await (const message of readUIMessageStream({ stream })) last = message;
  return last?.parts ?? [];
}

describe('compaction chunks reach the transcript', () => {
  it('leaves exactly one part, describing the settled outcome', async () => {
    const map = createCompactionMapper();
    const opened = map({ subtype: 'status', status: 'compacting' });
    const settled = map({ subtype: 'compact_boundary', compact_metadata: { trigger: 'manual' } });

    const parts = await partsFor([...opened, ...settled]);

    const compact = parts.filter((part) => part.type === 'data-compact');
    expect(compact).toHaveLength(1);
    expect(compact[0]).toMatchObject({ data: { state: 'output-available', trigger: 'manual' } });
  });

  it('leaves nothing behind while compaction is still running', async () => {
    const map = createCompactionMapper();

    const parts = await partsFor(map({ subtype: 'status', status: 'compacting' }));

    // A run killed mid-compaction must not strand a card reading "Compacting…" forever.
    expect(parts.filter((part) => part.type === 'data-compact')).toEqual([]);
  });

  it('renders a part for a failed compaction', async () => {
    const map = createCompactionMapper();
    const chunks = [
      ...map({ subtype: 'status', status: 'compacting' }),
      ...map({ subtype: 'status', compact_result: 'failed' }),
    ];

    const parts = await partsFor(chunks);

    const compact = parts.filter((part) => part.type === 'data-compact');
    expect(compact).toHaveLength(1);
    expect(compact[0]).toMatchObject({ data: { state: 'output-error' } });
  });

  it('upserts the summary the SDK streams after the boundary onto the same card', async () => {
    const map = createCompactionMapper();
    const chunks = [
      ...map({ type: 'system', subtype: 'status', status: 'compacting' }),
      ...map({
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'auto' },
      }),
      ...map({ type: 'user', message: { content: [{ type: 'text', text: 'the gist' }] } }),
    ];

    const parts = await partsFor(chunks);

    expect(parts.filter((part) => part.type === 'data-compact')).toMatchObject([
      { data: { state: 'output-available', trigger: 'auto', summary: 'the gist' } },
    ]);
  });

  it('takes no summary once the assistant has replied after the boundary', () => {
    const map = createCompactionMapper();
    map({ type: 'system', subtype: 'status', status: 'compacting' });
    map({ type: 'system', subtype: 'compact_boundary' });
    map({ type: 'assistant' });

    expect(map({ type: 'user', message: { content: 'a later prompt' } })).toEqual([]);
  });

  it('marks a compaction that kept messages verbatim as partial', () => {
    const map = createCompactionMapper();
    map({ type: 'system', subtype: 'status', status: 'compacting' });

    const [chunk] = map({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', preserved_messages: { anchor_uuid: 'a', uuids: ['b'] } },
    });

    expect(chunk).toMatchObject({ data: { partial: true } });
  });
});
