import { readUIMessageStream, type UIMessageChunk as SdkChunk } from 'ai';
import { describe, expect, it } from 'vitest';
import type { UIMessageChunk } from '../types';
import { compactionSummaryJoinFor, createCompactionMapper } from './index';

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

/** A mapper whose messages carry `sessionId`, and the summary join that session resolves to. */
function sessionMapper(sessionId: string) {
  const map = createCompactionMapper();
  return {
    join: compactionSummaryJoinFor(sessionId),
    map: (msg: Parameters<typeof map>[0]) => map({ session_id: sessionId, ...msg }),
  };
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

  it('carries the PostCompact summary on the settled part', async () => {
    const { join, map } = sessionMapper('mapper-session-1');
    const chunks = map({ subtype: 'status', status: 'compacting' });
    join.onSummary('what happened so far');
    chunks.push(...map({ subtype: 'compact_boundary', compact_metadata: { trigger: 'auto' } }));

    const parts = await partsFor(chunks);

    expect(parts.filter((part) => part.type === 'data-compact')).toMatchObject([
      { data: { state: 'output-available', trigger: 'auto', summary: 'what happened so far' } },
    ]);
  });

  it('upserts a summary re-emitted after the boundary onto the same part', async () => {
    const { join, map } = sessionMapper('mapper-session-2');
    const chunks = [
      ...map({ subtype: 'status', status: 'compacting' }),
      ...map({ subtype: 'compact_boundary', compact_metadata: { trigger: 'manual' } }),
    ];
    const reemit = join.onSummary('late summary');
    expect(reemit).not.toBeNull();
    chunks.push({ type: 'data-compact', id: reemit!.id, data: reemit!.data });

    const parts = await partsFor(chunks);

    expect(parts.filter((part) => part.type === 'data-compact')).toMatchObject([
      { data: { state: 'output-available', summary: 'late summary' } },
    ]);
  });

  it.each([
    ['preserved_messages', { preserved_messages: { anchor_uuid: 'a', uuids: ['b'] } }],
    [
      'preserved_segment',
      { preserved_segment: { head_uuid: 'a', anchor_uuid: 'b', tail_uuid: 'c' } },
    ],
  ])('marks a compaction that kept %s as partial', (_name, kept) => {
    const map = createCompactionMapper();
    map({ subtype: 'status', status: 'compacting' });

    const [chunk] = map({
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', ...kept },
    });

    expect(chunk).toMatchObject({ data: { state: 'output-available', partial: true } });
  });

  it('keeps a summary from an earlier, unseen compaction off the next card', () => {
    const { join, map } = sessionMapper('mapper-session-3');
    join.onSummary('from a compaction this stream never saw');

    map({ subtype: 'status', status: 'compacting' });
    const [chunk] = map({ subtype: 'compact_boundary', compact_metadata: { trigger: 'auto' } });

    expect(chunk).toMatchObject({ data: { state: 'output-available' } });
    expect((chunk as { data: { summary?: string } }).data.summary).toBeUndefined();
  });

  it('merges a summary that lands between the compacting status and the boundary', () => {
    const { join, map } = sessionMapper('mapper-session-4');

    map({ subtype: 'status', status: 'compacting' });
    join.onSummary('fresh');
    const [chunk] = map({ subtype: 'compact_boundary', compact_metadata: { trigger: 'manual' } });

    expect(chunk).toMatchObject({ data: { summary: 'fresh' } });
  });

  it('never joins a summary across sessions', () => {
    const a = sessionMapper('mapper-session-a');
    const b = sessionMapper('mapper-session-b');
    a.map({ subtype: 'status', status: 'compacting' });
    b.map({ subtype: 'status', status: 'compacting' });
    a.join.onSummary('summary for A');

    const [chunkB] = b.map({ subtype: 'compact_boundary', compact_metadata: { trigger: 'auto' } });
    const [chunkA] = a.map({ subtype: 'compact_boundary', compact_metadata: { trigger: 'auto' } });

    expect((chunkB as { data: { summary?: string } }).data.summary).toBeUndefined();
    expect(chunkA).toMatchObject({ data: { summary: 'summary for A' } });
  });
});
