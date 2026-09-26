import { describe, expect, it } from 'vitest';
import type { FrinkPlanData } from '../../../../shared/types/plan';
import { buildFrinkPlanChunks } from './index';

/** A plan shaped the way Claude Code's native plan mode writes one: no numbered steps section. */
const CLAUDE_PLAN = `# Fix plan approval

## Context
- Approving long plans failed.
- The card showed context bullets as todos.

## Change
Hand the approved plan to the execution turn verbatim.

## Verification
- \`bun run test:run\``;

function planInput(chunks: ReturnType<typeof buildFrinkPlanChunks>): FrinkPlanData {
  // SAFETY: buildFrinkPlanChunks emits the frink-plan tool-input chunk first.
  return (chunks[0] as { input: FrinkPlanData }).input;
}

describe('buildFrinkPlanChunks', () => {
  it('emits a frink-plan input chunk and an output chunk sharing one toolCallId', () => {
    const chunks = buildFrinkPlanChunks('sub-abc', CLAUDE_PLAN, '/path/to/plan.md');

    expect(chunks.map((chunk) => chunk.type)).toEqual([
      'tool-input-available',
      'tool-output-available',
    ]);
    // SAFETY: both chunk variants emitted here carry a toolCallId.
    const [input, output] = chunks as Array<{ toolCallId: string; toolName?: string }>;
    expect(input?.toolName).toBe('frink-plan');
    expect(input?.toolCallId).toBe(output?.toolCallId);
  });

  it('throws when plan text is empty after trimming', () => {
    expect(() => buildFrinkPlanChunks('sub-abc', '   \n  ', null)).toThrow(
      'buildFrinkPlanChunks requires non-empty plan text.',
    );
  });

  it('keeps the plan text exactly as the agent wrote it and invents no steps', () => {
    const plan = planInput(buildFrinkPlanChunks('sub-abc', `\n${CLAUDE_PLAN}\n`, '/plan.md'));

    expect(plan.planText).toBe(CLAUDE_PLAN);
    expect(plan.planPath).toBe('/plan.md');
    expect(plan).not.toHaveProperty('steps');
    expect(plan.status).toBe('awaiting_approval');
  });

  it('omits planPath when there is no plan file', () => {
    expect(planInput(buildFrinkPlanChunks('sub-abc', CLAUDE_PLAN, null)).planPath).toBeUndefined();
  });

  it('autoApproved marks the plan approved and keeps flowDriven', () => {
    const plan = planInput(
      buildFrinkPlanChunks('sub-abc', CLAUDE_PLAN, null, { autoApproved: true, flowDriven: true }),
    );
    expect(plan.status).toBe('approved');
    expect(plan.flowDriven).toBe(true);
  });

  it('flowDriven without autoApproved stays awaiting_approval', () => {
    const plan = planInput(
      buildFrinkPlanChunks('sub-abc', CLAUDE_PLAN, null, { flowDriven: true }),
    );
    expect(plan.status).toBe('awaiting_approval');
    expect(plan.flowDriven).toBe(true);
  });

  describe('summary', () => {
    it('previews the body without frontmatter, keeping markdown structure', () => {
      const summary = planInput(
        buildFrinkPlanChunks('sub-abc', `---\nname: fix\n---\n\n${CLAUDE_PLAN}`, null),
      ).summary;

      expect(summary).not.toContain('name: fix');
      expect(summary).toContain('## Context\n- Approving long plans failed.');
    });

    it('truncates a long body on a word boundary with an ellipsis', () => {
      const summary = planInput(
        buildFrinkPlanChunks('sub-abc', `## Context\n${'word '.repeat(400)}`, null),
      ).summary;

      expect(summary.length).toBeLessThanOrEqual(603);
      expect(summary).toMatch(/word\.\.\.$/);
    });

    it('caps runs of 3+ blank lines down to a single blank line', () => {
      const summary = planInput(
        buildFrinkPlanChunks('sub-abc', 'Line one.\n\n\n\n\nLine two.', null),
      ).summary;
      expect(summary).toBe('Line one.\n\nLine two.');
    });
  });
});
