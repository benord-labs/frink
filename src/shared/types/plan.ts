/**
 * Frink-owned canonical plan model.
 *
 * **Canonical source:** `src/shared/types/plan.ts` — the source of truth for plan state. The mirror at
 * at dev/deploy; do not edit the mirror by hand and nothing to commit. See
 * docs/decisions/shared-runtime-boundary.md.
 *
 * Provider-native flags (`--mode=plan`) are an optional substrate hint, not the plan contract.
 *
 * The minimum approved execution payload (`ApprovedPlanContext`) must survive:
 * - Provider session loss or expiry
 * - Context compression
 * - Cross-machine handoff
 * - Retry/resume
 */

// ============================================================================
// Canonical plan status
// ============================================================================

export type FrinkPlanStatus =
  | 'draft' // Plan turn in progress — not yet complete
  | 'awaiting_approval' // Plan complete, waiting for user to approve
  | 'approved' // User approved, ready for execution
  | 'in_progress' // Execution running
  | 'completed'; // Execution done

// A leading `---` block counts as frontmatter only when it opens with a YAML `key:`, so a plan that
// starts with a markdown horizontal rule keeps its first section.
const PLAN_FRONTMATTER_BLOCK_REGEX = /^---\s*\n(?=[A-Za-z_][\w-]*\s*:)[\s\S]*?\n---\s*(?=\n|$)/;

/**
 * Remove a leading/frontmatter YAML block from plan markdown.
 * Returns trimmed text and preserves non-frontmatter text when no block exists.
 */
export function stripPlanFrontmatter(planText: string): string {
  const match = PLAN_FRONTMATTER_BLOCK_REGEX.exec(planText);
  if (!match) return planText.trim();
  const withoutFrontmatter = planText.slice(match[0].length).trim();
  return withoutFrontmatter || planText.trim();
}

// ============================================================================
// Canonical plan data (emitted by agent in plan turn)
// ============================================================================

/**
 * Frink-owned plan data, embedded in a tool message part.
 * In runtime message parts this appears as `type: "tool-frink-plan"` because
 * tool chunks are normalized to `tool-${toolName}`.
 * This is the canonical runtime representation — any markdown file is a mirror.
 */
export type FrinkPlanData = {
  /** Unique plan ID (same as toolCallId for the frink-plan message part) */
  planId: string;
  /** Short plain preview of the plan for the collapsed card */
  summary: string;
  /** Optional path to mirror `.plan.md` file (not the source of truth) */
  planPath?: string;
  /**
   * The plan markdown exactly as the agent wrote it. It is what the card renders and what Approve
   * hands to the execution turn, so the user approves the same text the agent then implements.
   */
  planText: string;
  /** Plan status */
  status: FrinkPlanStatus;
  /**
   * True when this plan was produced by a Flow run's plan-mode agent node. The Flow run panel owns
   * approval (resumeFlowRun → advances to the execute node), so the chat plan card suppresses its
   * own Approve button — clicking it would continue the chat turn while the flow stays paused and
   * its execute node later re-runs (double execution). Approval flows ONLY through the flow panel.
   */
  flowDriven?: boolean;
};

/** Canonical assistant message part `type` for the Frink plan tool (`tool-${toolName}`). */
export const FRINK_PLAN_MESSAGE_PART_TYPE = 'tool-frink-plan' as const;

/**
 * Older persisted payloads used `type: "frink-plan"` before SDK normalization to `tool-frink-plan`.
 * Normalize at hydration so the app only branches on {@link FRINK_PLAN_MESSAGE_PART_TYPE}.
 */
export function normalizeFrinkPlanMessagePartType(type: string): string {
  return type === 'frink-plan' ? FRINK_PLAN_MESSAGE_PART_TYPE : type;
}

/** True when the part type is the canonical Frink plan card (after normalization). */
export function isFrinkPlanMessagePartType(type: string): boolean {
  return normalizeFrinkPlanMessagePartType(type) === FRINK_PLAN_MESSAGE_PART_TYPE;
}

// ============================================================================
// Minimum approved execution payload
// ============================================================================

/**
 * Payload that carries an approved plan into the execution turn.
 *
 * The executor injects this into `fullPrompt` when mode is "agent" and a plan is approved.
 *
 * Transmitted on the `MessageSendPayload` as `approvedPlanContext` so the approved
 * plan meaning survives session loss, compression, and retry.
 */
export type ApprovedPlanContext = {
  /** Canonical plan identifier for lifecycle transitions */
  planId?: string;
  /** The approved plan markdown, verbatim (frontmatter stripped) */
  planText: string;
};

export const APPROVED_PLAN_ID_MAX_CHARS = 128;
export const PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT =
  'Implement the approved plan from the approved_plan context.';

// ============================================================================
// Plan readiness predicates
// ============================================================================

export type MessagePartLike = {
  type: string;
  text?: string;
  output?: unknown;
  input?: Record<string, unknown>;
};

export type PlanMessageLike = {
  role: string;
  parts?: MessagePartLike[];
};

/**
 * Check if a message part represents a completed Frink-native plan
 * ready for user approval (`status === "awaiting_approval"`).
 * Accepts historical `type: "frink-plan"` parts via {@link normalizeFrinkPlanMessagePartType}.
 */
export function isFrinkPlanReadyPart(part: MessagePartLike): boolean {
  if (!isFrinkPlanMessagePartType(part.type)) return false;
  const input = part.input as { status?: string } | undefined;
  return input?.status === 'awaiting_approval';
}

/**
 * Check if a message part signals canonical plan-ready approval.
 */
export function isPlanReadyPart(part: MessagePartLike): boolean {
  return isFrinkPlanReadyPart(part);
}

/**
 * Scan a message's parts for an unapproved plan signal.
 * Returns the approved plan context if a frink-plan part is found,
 * so callers can extract the approved `planText` without re-scanning.
 */
export function findUnapprovedPlanPart(
  parts: MessagePartLike[],
): { planContext: ApprovedPlanContext | null; flowDriven: boolean } | null {
  for (const part of parts) {
    if (isFrinkPlanReadyPart(part)) {
      const input = part.input as FrinkPlanData | undefined;
      const planText =
        typeof input?.planText === 'string' ? stripPlanFrontmatter(input.planText) : '';
      if (!input || !planText) return { planContext: null, flowDriven: false };

      return {
        // Carried so approval gates can rule on THIS plan (a flow plan is approved only via the
        // run panel / chat reply, never the in-chat button) without re-scanning the transcript.
        flowDriven: input.flowDriven === true,
        planContext: {
          planId: input.planId,
          planText,
        },
      };
    }
  }

  return null;
}

/**
 * Return whether the current plan approval epoch is still open.
 *
 * A persisted transcript keeps historical `awaiting_approval` plan parts after approval. The
 * approval execution trigger closes that epoch, while the newest canonical plan part supersedes
 * every older plan regardless of status. Scanning newest-first prevents re-entering Plan mode from
 * resurrecting an already-approved historical plan before a new plan is produced.
 */
export function hasCurrentUnapprovedPlan(
  messages: PlanMessageLike[],
  isPlanMode: boolean,
): boolean {
  if (!isPlanMode) return false;

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const message = messages[messageIndex];
    const parts = message?.parts ?? [];

    if (message?.role === 'assistant') {
      for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
        const part = parts[partIndex];
        if (!part || !isFrinkPlanMessagePartType(part.type)) continue;
        return isFrinkPlanReadyPart(part);
      }
    }

    if (message?.role === 'user') {
      for (const part of parts) {
        if (part.type === 'text' && part.text && isPlanApprovalTriggerText(part.text)) {
          return false;
        }
      }
    }
  }

  return false;
}

/**
 * The plan a chat's Approve acts on: the newest plan, still open for approval, with usable text.
 * Null for a Flow run's plan, which the run approves itself (see {@link FrinkPlanData.flowDriven}).
 */
export function findApprovablePlan(
  messages: PlanMessageLike[],
  isPlanMode: boolean,
): ApprovedPlanContext | null {
  if (!hasCurrentUnapprovedPlan(messages, isPlanMode)) return null;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    const found = message?.role === 'assistant' && findUnapprovedPlanPart(message.parts ?? []);
    if (found) return found.flowDriven ? null : found.planContext;
  }
  return null;
}

export function isPlanApprovalTriggerText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized === PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT.toLowerCase();
}

// ============================================================================
// Execution prompt injection
// ============================================================================

/**
 * Build the approved-plan context block to inject into execution prompts.
 * This is the text injected at the start of the plan-approved execution turn
 * so the agent knows what plan was approved, even when provider session memory
 * is stale or missing.
 */
export function buildApprovedPlanContextBlock(ctx: ApprovedPlanContext): string {
  return [
    '<approved_plan>',
    ctx.planText.trim(),
    '</approved_plan>',
    '',
    'The plan above is already approved.',
    'Implement it now and do not generate a new plan.',
  ].join('\n');
}
