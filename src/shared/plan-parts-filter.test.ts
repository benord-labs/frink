import { describe, expect, it } from 'vitest';
import { extractCanonicalPlanTextForFilter, filterCanonicalPlanParts } from './plan-parts-filter';

describe('extractCanonicalPlanTextForFilter', () => {
  it('returns planText from tool-frink-plan input', () => {
    const parts = [{ type: 'tool-frink-plan', input: { planText: '## Plan\nBody' } }];
    expect(extractCanonicalPlanTextForFilter(parts)).toBe('## Plan\nBody');
  });

  it('returns null when no canonical plan part', () => {
    expect(extractCanonicalPlanTextForFilter([{ type: 'text', text: 'x' }])).toBeNull();
  });

  it('returns null when planText is empty or whitespace-only', () => {
    expect(
      extractCanonicalPlanTextForFilter([{ type: 'tool-frink-plan', input: { planText: '' } }]),
    ).toBeNull();
    expect(
      extractCanonicalPlanTextForFilter([
        { type: 'tool-frink-plan', input: { planText: '   \n  ' } },
      ]),
    ).toBeNull();
  });

  it('returns planText from historical frink-plan part type (normalized in filter)', () => {
    const parts = [{ type: 'frink-plan', input: { planText: '## Plan\nBody' } }];
    expect(extractCanonicalPlanTextForFilter(parts)).toBe('## Plan\nBody');
  });
});

describe('persisted plan final parts (executor buildFinalPartsForPersist pattern)', () => {
  it('removes duplicate text blob when frink-plan carries planText', () => {
    const rawPlan = '## Overview\nPersisted duplicate body';
    const raw = [
      { type: 'text', text: rawPlan },
      {
        type: 'tool-frink-plan',
        toolCallId: 'frink-plan-sub-1',
        input: {
          planId: 'frink-plan-sub-1',
          summary: 'Summary',
          status: 'awaiting_approval',
          planText: rawPlan,
        },
      },
    ];
    const planText = extractCanonicalPlanTextForFilter(raw);
    expect(filterCanonicalPlanParts(raw, planText ?? undefined)).toEqual([
      {
        type: 'tool-frink-plan',
        toolCallId: 'frink-plan-sub-1',
        input: {
          planId: 'frink-plan-sub-1',
          summary: 'Summary',
          status: 'awaiting_approval',
          planText: rawPlan,
        },
      },
    ]);
  });

  it('does not remove duplicate text when frink-plan has no planText (no dedupe without canonical body)', () => {
    const body = '## Same block';
    const raw = [
      { type: 'text', text: body },
      { type: 'text', text: body },
      {
        type: 'tool-frink-plan',
        toolCallId: 'x',
        input: {
          planId: 'x',
          summary: 'Summary',
          status: 'awaiting_approval',
        },
      },
    ];
    const planText = extractCanonicalPlanTextForFilter(raw);
    expect(planText).toBeNull();
    expect(filterCanonicalPlanParts(raw, planText ?? undefined)).toEqual(raw);
  });

  it('still removes tool-PlanWrite when frink-plan exists without planText', () => {
    const raw = [
      {
        type: 'tool-PlanWrite',
        toolCallId: 'pw-1',
        input: { action: 'create', plan: { id: 'p' } },
      },
      {
        type: 'tool-frink-plan',
        toolCallId: 'frink-1',
        input: {
          planId: 'frink-1',
          summary: 'Summary',
          status: 'awaiting_approval',
        },
      },
    ];
    const planText = extractCanonicalPlanTextForFilter(raw);
    expect(planText).toBeNull();
    expect(filterCanonicalPlanParts(raw, planText ?? undefined)).toEqual([raw[1]]);
  });

  it('strips duplicate plan when message spacing differs from canonical planText', () => {
    const rawPlan = '## Overview\nBody';
    const textWithDifferentSpacing = 'Note\n\n## Overview\n\nBody';
    const tool = {
      type: 'tool-frink-plan' as const,
      toolCallId: 'frink-plan-sub-1',
      input: {
        planId: 'frink-plan-sub-1',
        summary: 'Summary',
        status: 'awaiting_approval' as const,
        planText: rawPlan,
      },
    };
    const raw = [{ type: 'text' as const, text: textWithDifferentSpacing }, tool];
    const planText = extractCanonicalPlanTextForFilter(raw);
    expect(filterCanonicalPlanParts(raw, planText ?? undefined)).toEqual([
      { type: 'text', text: 'Note' },
      tool,
    ]);
  });

  it('strips duplicate plan when first heading is h4+ and spacing differs from canonical planText', () => {
    const rawPlan = '#### Overview\nBody';
    const textWithDifferentSpacing = 'Note\n\n#### Overview\n\nBody';
    const tool = {
      type: 'tool-frink-plan' as const,
      toolCallId: 'frink-plan-sub-1',
      input: {
        planId: 'frink-plan-sub-1',
        summary: 'Summary',
        status: 'awaiting_approval' as const,
        planText: rawPlan,
      },
    };
    const raw = [{ type: 'text' as const, text: textWithDifferentSpacing }, tool];
    const planText = extractCanonicalPlanTextForFilter(raw);
    expect(filterCanonicalPlanParts(raw, planText ?? undefined)).toEqual([
      { type: 'text', text: 'Note' },
      tool,
    ]);
  });

  it('dedupes intro when canonical plan has no ATX heading (uses remainder path, not pre-heading split)', () => {
    const rawPlan = 'Title line\nSecond line';
    const tool = {
      type: 'tool-frink-plan' as const,
      toolCallId: 't1',
      input: {
        planId: 't1',
        summary: 'Summary',
        status: 'awaiting_approval' as const,
        planText: rawPlan,
      },
    };
    const raw = [{ type: 'text' as const, text: 'Preamble\n\nTitle line\nSecond line' }, tool];
    const planText = extractCanonicalPlanTextForFilter(raw);
    expect(filterCanonicalPlanParts(raw, planText ?? undefined)).toEqual([
      { type: 'text', text: 'Preamble' },
      tool,
    ]);
  });

  it('treats the first ATX # sequence in raw text as the heading split (including inside fenced blocks)', () => {
    const rawPlan = '## Real overview\nBody';
    const tool = {
      type: 'tool-frink-plan' as const,
      toolCallId: 't1',
      input: {
        planId: 't1',
        summary: 'Summary',
        status: 'awaiting_approval' as const,
        planText: rawPlan,
      },
    };
    const rawText = 'Intro\n```\n## Decoy in fence\n```\n\n## Real overview\nBody';
    const raw = [{ type: 'text' as const, text: rawText }, tool];
    const planText = extractCanonicalPlanTextForFilter(raw);
    expect(filterCanonicalPlanParts(raw, planText ?? undefined)).toEqual([
      { type: 'text', text: 'Intro\n```' },
      tool,
    ]);
  });
});
