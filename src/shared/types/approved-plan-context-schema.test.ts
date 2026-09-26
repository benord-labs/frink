import { describe, expect, it } from 'vitest';
import { approvedPlanContextSchema } from './approved-plan-context-schema';

describe('approvedPlanContextSchema', () => {
  it('accepts a long approved plan without truncating it', () => {
    const planText = `## Change\n${Array.from({ length: 60 }, (_, i) => `- Step ${i + 1}`).join('\n')}`;
    const result = approvedPlanContextSchema.safeParse({ planId: 'plan-123', planText });
    expect(result.success && result.data.planText).toBe(planText);
  });

  it('rejects blank planText', () => {
    expect(approvedPlanContextSchema.safeParse({ planText: '   ' }).success).toBe(false);
  });

  it('rejects blank planId when provided', () => {
    const result = approvedPlanContextSchema.safeParse({ planId: '   ', planText: '## Plan' });
    expect(result.success).toBe(false);
  });
});
