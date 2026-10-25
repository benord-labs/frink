import { describe, expect, it } from 'vitest';
import { WEBHOOK_FILTER_OPERATORS } from '../../../../../shared/lib/webhook-match';
import { getBlocksTriggersGuideline } from './blocks-triggers';

describe('getBlocksTriggersGuideline', () => {
  // Agents write webhook filters from this text; an operator missing here gets invented.
  it('lists every operator the webhook matcher reads', () => {
    const text = getBlocksTriggersGuideline();
    expect(text).toContain('`conditions.filters` is a list of `{ field, operator, value }`');
    for (const operator of WEBHOOK_FILTER_OPERATORS) expect(text).toContain(`\`${operator}\``);
  });

  // Agents build flows from this table; an optional field read as always present renders blank.
  it('marks the post-task fields some runs leave out', () => {
    const text = getBlocksTriggersGuideline();
    expect(text).toContain('| `branch` | string | Git branch the task ran on (not always present) |');
    expect(text).toContain('| `taskId` | string | UUID of the completed task |');
  });
});
