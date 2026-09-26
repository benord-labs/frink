import { describe, expect, it } from 'vitest';
import {
  buildApprovedPlanContextBlock,
  FRINK_PLAN_MESSAGE_PART_TYPE,
  findUnapprovedPlanPart,
  hasCurrentUnapprovedPlan,
  isFrinkPlanMessagePartType,
  isFrinkPlanReadyPart,
  isPlanApprovalTriggerText,
  isPlanReadyPart,
  normalizeFrinkPlanMessagePartType,
  PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT,
  stripPlanFrontmatter,
} from './plan';

describe('shared/types/plan', () => {
  describe('isFrinkPlanReadyPart', () => {
    it('returns true for tool-frink-plan part with awaiting_approval status', () => {
      const part = {
        type: 'tool-frink-plan',
        input: { status: 'awaiting_approval', planId: 'test', summary: 'x' },
        output: { success: true },
      };
      expect(isFrinkPlanReadyPart(part)).toBe(true);
    });

    it('returns false for tool-frink-plan part with non-approval status', () => {
      const part = {
        type: 'tool-frink-plan',
        input: { status: 'approved' },
      };
      expect(isFrinkPlanReadyPart(part)).toBe(false);
    });

    it('treats historical frink-plan part type as ready after normalization', () => {
      const part = {
        type: 'frink-plan',
        input: { status: 'awaiting_approval' },
      };
      expect(normalizeFrinkPlanMessagePartType(part.type)).toBe(FRINK_PLAN_MESSAGE_PART_TYPE);
      expect(isFrinkPlanMessagePartType(part.type)).toBe(true);
      expect(isFrinkPlanReadyPart(part)).toBe(true);
    });

    it('returns false for other tool types', () => {
      expect(isFrinkPlanReadyPart({ type: 'tool-PlanWrite', output: {} })).toBe(false);
      expect(isFrinkPlanReadyPart({ type: 'text' })).toBe(false);
    });
  });

  describe('isPlanReadyPart', () => {
    it('returns true for tool-frink-plan awaiting_approval', () => {
      const part = {
        type: 'tool-frink-plan',
        input: { status: 'awaiting_approval' },
        output: {},
      };
      expect(isPlanReadyPart(part)).toBe(true);
    });

    it('returns false for non-canonical tool parts', () => {
      const part = { type: 'tool-PlanWrite', output: {} };
      expect(isPlanReadyPart(part)).toBe(false);
    });

    it('returns false for unrelated parts', () => {
      expect(isPlanReadyPart({ type: 'text' })).toBe(false);
      expect(isPlanReadyPart({ type: 'tool-Write', input: { file_path: 'foo.md' } })).toBe(false);
    });
  });

  describe('findUnapprovedPlanPart', () => {
    it('hands off the full plan text verbatim, without its frontmatter', () => {
      const planText =
        '## Context\n- Long plans failed approval.\n\n## Change\n1. Send the plan as-is.';
      const parts = [
        {
          type: 'tool-frink-plan',
          input: {
            planId: 'plan-1',
            summary: 'Do the thing',
            planText: `---\nname: fix\n---\n\n${planText}`,
            planPath: '/path/to/plan.md',
            status: 'awaiting_approval',
          },
          output: { success: true },
        },
      ];
      const result = findUnapprovedPlanPart(parts);
      expect(result?.planContext).toEqual({ planId: 'plan-1', planText });
    });

    it('offers no plan context when the part carries no plan text', () => {
      const parts = [
        {
          type: 'tool-frink-plan',
          input: {
            planId: 'plan-1',
            summary: 'Do the thing',
            status: 'awaiting_approval',
          },
        },
      ];
      expect(findUnapprovedPlanPart(parts)).toEqual({
        planContext: null,
        flowDriven: false,
      });
    });

    it('returns plan context from historical frink-plan part type (no toMessage pass-through)', () => {
      const parts = [
        {
          type: 'frink-plan',
          input: {
            planId: 'plan-hist',
            summary: 'Summary text',
            planText: '## Plan\nDo one thing.',
            status: 'awaiting_approval',
          },
        },
      ];
      const result = findUnapprovedPlanPart(parts);
      expect(result).not.toBeNull();
      expect(result?.planContext?.planId).toBe('plan-hist');
      expect(result?.planContext?.planText).toBe('## Plan\nDo one thing.');
    });

    it('ignores non-canonical tool parts', () => {
      const parts = [
        {
          type: 'tool-PlanWrite',
          input: { planPath: '/legacy/plan.md' },
          output: { success: true },
        },
      ];
      expect(findUnapprovedPlanPart(parts)).toBeNull();
    });

    it('returns null when no plan-ready parts', () => {
      const parts = [{ type: 'text' }, { type: 'tool-Write' }];
      expect(findUnapprovedPlanPart(parts)).toBeNull();
    });
  });

  describe('hasCurrentUnapprovedPlan', () => {
    const planMessage = (status: string, planId = status) => ({
      role: 'assistant',
      parts: [
        {
          type: 'tool-frink-plan',
          input: { status, planId, summary: 'Plan', planText: '## Plan' },
        },
      ],
    });

    it('detects a fresh awaiting-approval plan only in Plan mode', () => {
      expect(hasCurrentUnapprovedPlan([planMessage('awaiting_approval')], true)).toBe(true);
      expect(hasCurrentUnapprovedPlan([planMessage('awaiting_approval')], false)).toBe(false);
    });

    it('treats the persisted approval execution trigger as an epoch boundary', () => {
      const messages = [
        planMessage('awaiting_approval', 'old-plan'),
        {
          role: 'user',
          parts: [{ type: 'text', text: PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT }],
        },
        {
          role: 'assistant',
          parts: [{ type: 'text', text: 'Implementation complete.' }],
        },
        {
          role: 'user',
          parts: [{ type: 'text', text: 'Plan the follow-up.' }],
        },
      ];

      expect(hasCurrentUnapprovedPlan(messages, true)).toBe(false);
    });

    it('lets a newer pending plan open a new epoch after an approved plan', () => {
      const messages = [
        planMessage('awaiting_approval', 'old-plan'),
        {
          role: 'user',
          parts: [{ type: 'text', text: PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT }],
        },
        planMessage('awaiting_approval', 'new-plan'),
      ];

      expect(hasCurrentUnapprovedPlan(messages, true)).toBe(true);
    });

    it('uses the newest canonical plan status and ignores older awaiting plans', () => {
      expect(
        hasCurrentUnapprovedPlan(
          [planMessage('awaiting_approval', 'old-plan'), planMessage('approved', 'new-plan')],
          true,
        ),
      ).toBe(false);
    });
  });

  describe('buildApprovedPlanContextBlock', () => {
    it('wraps the approved plan text and tells the agent to implement it', () => {
      const planText = '## Change\n- Write the function\n- Add tests';
      expect(buildApprovedPlanContextBlock({ planText: `\n${planText}\n` })).toBe(
        [
          '<approved_plan>',
          planText,
          '</approved_plan>',
          '',
          'The plan above is already approved.',
          'Implement it now and do not generate a new plan.',
        ].join('\n'),
      );
    });
  });

  describe('isPlanApprovalTriggerText', () => {
    it('accepts the new execution trigger text', () => {
      expect(isPlanApprovalTriggerText(PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT)).toBe(true);
      expect(isPlanApprovalTriggerText(` ${PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT} `)).toBe(true);
    });

    it('returns false for other user messages', () => {
      expect(isPlanApprovalTriggerText('Build plan')).toBe(false);
      expect(isPlanApprovalTriggerText('Build a plan for this task')).toBe(false);
      expect(isPlanApprovalTriggerText('Continue')).toBe(false);
    });
  });

  describe('stripPlanFrontmatter', () => {
    it('strips leading YAML frontmatter from plan text', () => {
      const text = `---
name: test-plan
overview: hello
todos: []
isProject: false
---

## Overview
Body content`;
      expect(stripPlanFrontmatter(text)).toBe('## Overview\nBody content');
    });

    it('keeps a plan that opens with a markdown horizontal rule intact', () => {
      const text = '---\n## Phase 1\nDo A\n---\n## Phase 2\nDo B';
      expect(stripPlanFrontmatter(text)).toBe(text);
    });

    it('returns trimmed original text when no frontmatter exists', () => {
      const text = '  ## Overview\nBody content  ';
      expect(stripPlanFrontmatter(text)).toBe('## Overview\nBody content');
    });

    it('does not strip embedded frontmatter-like blocks', () => {
      const text = `## Overview
Body content

---
name: embedded
---
More body`;
      expect(stripPlanFrontmatter(text)).toBe(text);
    });
  });
});
