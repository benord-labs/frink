import { describe, expect, it } from 'vitest';
import { compactionSummaryJoinFor, createCompactionSummaryJoin } from './summary-join';

const settled = { state: 'output-available' as const, trigger: 'manual' as const };

describe('createCompactionSummaryJoin', () => {
  it('merges a summary that arrived before the boundary', () => {
    const join = createCompactionSummaryJoin();

    expect(join.onSummary('the summary')).toBeNull();
    expect(join.onSettled('compact-1', settled)).toEqual({ ...settled, summary: 'the summary' });
  });

  it('re-emits the settled card by id when the summary arrives second', () => {
    const join = createCompactionSummaryJoin();

    expect(join.onSettled('compact-1', settled)).toEqual(settled);
    expect(join.onSummary('the summary')).toEqual({
      id: 'compact-1',
      data: { ...settled, summary: 'the summary' },
    });
  });

  it('never carries a used summary onto the next compaction', () => {
    const join = createCompactionSummaryJoin();
    join.onSummary('first');
    join.onSettled('compact-1', settled);

    expect(join.onSettled('compact-2', settled)).toEqual(settled);
    expect(join.onSummary('second')).toEqual({
      id: 'compact-2',
      data: { ...settled, summary: 'second' },
    });
    // Both sides consumed: a stray later summary waits rather than re-emitting an old card.
    expect(join.onSummary('stray')).toBeNull();
  });

  it('drops a summary whose boundary never reached a transformer when the next compaction starts', () => {
    // A wake hold with no burst open swallows the boundary; its summary must not caption the next card.
    const join = createCompactionSummaryJoin();
    join.onSummary('stale summary');

    join.onStart();

    expect(join.onSettled('compact-2', settled)).toEqual(settled);
  });

  it('does not re-emit an old card when its summary never came and a new compaction starts', () => {
    const join = createCompactionSummaryJoin();
    join.onSettled('compact-1', settled);

    join.onStart();

    expect(join.onSummary('new summary')).toBeNull();
    expect(join.onSettled('compact-2', settled)).toEqual({ ...settled, summary: 'new summary' });
  });
});

describe('compactionSummaryJoinFor', () => {
  it('returns the same join for a session and a separate one for another', () => {
    expect(compactionSummaryJoinFor('join-registry-1')).toBe(
      compactionSummaryJoinFor('join-registry-1'),
    );
    expect(compactionSummaryJoinFor('join-registry-1')).not.toBe(
      compactionSummaryJoinFor('join-registry-2'),
    );
  });

  it('forgets the oldest session once it tracks more than its cap', () => {
    const first = compactionSummaryJoinFor('join-cap-0');
    for (let i = 1; i <= 64; i++) compactionSummaryJoinFor(`join-cap-${i}`);

    expect(compactionSummaryJoinFor('join-cap-0')).not.toBe(first);
  });
});
