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
});
