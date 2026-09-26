/**
 * Dedupe plan markdown and native plan tool rows when a canonical `tool-frink-plan` card exists.
 * Used by the executor for persisted `finalParts` and by the renderer when rendering stored assistant messages.
 */

import { FRINK_PLAN_MESSAGE_PART_TYPE, normalizeFrinkPlanMessagePartType } from './types/plan';

export type CanonicalPlanPartLike = {
  type: string;
  text?: string;
  input?: Record<string, unknown>;
  [key: string]: unknown;
};

function normalizePlanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

const WHITESPACE_CHAR_REGEX = /\s/;

/** One char of whitespace-normalized output maps to this inclusive span in the raw string. */
type NormCharSpan = { rawStart: number; rawEnd: number };

/**
 * Mirrors {@link normalizePlanText}: trim + collapse internal whitespace to single spaces,
 * while recording which raw slice each normalized character came from.
 */
function mapNormalizedChars(raw: string): { norm: string; spans: NormCharSpan[] } {
  const spans: NormCharSpan[] = [];
  let i = 0;
  const len = raw.length;
  while (i < len && WHITESPACE_CHAR_REGEX.test(raw.charAt(i))) i++;
  let norm = '';
  while (i < len) {
    const ch = raw.charAt(i);
    if (WHITESPACE_CHAR_REGEX.test(ch)) {
      const wsStart = i;
      while (i < len && WHITESPACE_CHAR_REGEX.test(raw.charAt(i))) i++;
      if (i >= len) break;
      norm += ' ';
      spans.push({ rawStart: wsStart, rawEnd: i });
    } else {
      norm += ch;
      spans.push({ rawStart: i, rawEnd: i + 1 });
      i++;
    }
  }
  return { norm, spans };
}

/**
 * Removes every non-overlapping occurrence of `needleNorm` from the normalized form of `rawText`,
 * then concatenates the raw slices for kept characters (preserves original spacing outside removed spans).
 */
function rawRemainderAfterRemovingAllNormalized(rawText: string, needleNorm: string): string {
  if (!needleNorm) return rawText;
  const { norm, spans } = mapNormalizedChars(rawText);
  if (!norm.includes(needleNorm)) return rawText;

  const remove = new Array<boolean>(norm.length).fill(false);
  let idx = 0;
  while (idx <= norm.length - needleNorm.length) {
    if (norm.slice(idx, idx + needleNorm.length) === needleNorm) {
      for (let j = 0; j < needleNorm.length; j++) remove[idx + j] = true;
      idx += needleNorm.length;
    } else {
      idx++;
    }
  }

  let out = '';
  for (let j = 0; j < norm.length; j++) {
    if (!remove[j]) {
      const s = spans[j];
      if (s === undefined) continue;
      out += rawText.slice(s.rawStart, s.rawEnd);
    }
  }
  return out.trim();
}

/**
 * First ATX heading (CommonMark levels 1–6) in the raw text part, used to split intro-only text before
 * the duplicate plan body when normalizing spacing. **Not fence-aware**: a `##` line inside a fenced
 * code block matches first and becomes the split anchor (see tests: "Decoy in fence").
 */
const FIRST_MARKDOWN_HEADING_REGEX = /#{1,6}\s+\S/;

/**
 * Read full plan markdown from the canonical frink-plan tool part (for text dedupe).
 * Does not inspect ATX headings; heading-based splitting lives in {@link filterCanonicalPlanParts}.
 */
export function extractCanonicalPlanTextForFilter(
  parts: readonly CanonicalPlanPartLike[],
): string | null {
  for (const p of parts) {
    if (normalizeFrinkPlanMessagePartType(p.type) !== FRINK_PLAN_MESSAGE_PART_TYPE) continue;
    const input = p.input as { planText?: string } | undefined;
    if (typeof input?.planText === 'string' && input.planText.trim().length > 0) {
      return input.planText;
    }
  }
  return null;
}

/**
 * Remove duplicate plan markdown text and native PlanWrite tool rows when the canonical
 * frink-plan card carries the same content.
 *
 * When trimming a text part that contains the canonical plan, the first ATX `#`… sequence in the
 * **raw** assistant message is the split anchor (see {@link FIRST_MARKDOWN_HEADING_REGEX}). That
 * detection is intentionally **not** CommonMark fence–aware: a `##` inside a fenced code block
 * still counts first—documented so maintainers do not “fix” this into fence-aware parsing (see tests).
 */
export function filterCanonicalPlanParts(
  parts: CanonicalPlanPartLike[],
  planText?: string | null,
): CanonicalPlanPartLike[] {
  const normalizedPlan = planText ? normalizePlanText(planText) : '';
  const filtered: CanonicalPlanPartLike[] = [];

  for (const part of parts) {
    if (part.type === 'tool-PlanWrite') continue;
    if (part.type !== 'text' || !normalizedPlan) {
      filtered.push(part);
      continue;
    }

    const text = typeof part.text === 'string' ? normalizePlanText(part.text) : '';
    if (!text) {
      filtered.push(part);
      continue;
    }

    if (text === normalizedPlan) continue;
    if (!text.includes(normalizedPlan)) {
      filtered.push(part);
      continue;
    }

    const rawText = typeof part.text === 'string' ? part.text : '';
    // Fence-unaware on purpose: first match of FIRST_MARKDOWN_HEADING_REGEX wins (incl. inside ```).
    const firstHeadingIdx = rawText.search(FIRST_MARKDOWN_HEADING_REGEX);
    if (firstHeadingIdx > 0) {
      const preHeadingText = rawText.slice(0, firstHeadingIdx).trim();
      if (preHeadingText) {
        filtered.push({ ...part, text: preHeadingText });
      }
      continue;
    }

    const remainder = rawRemainderAfterRemovingAllNormalized(rawText, normalizedPlan);
    if (remainder) {
      filtered.push({ ...part, text: remainder });
    }
  }

  return filtered;
}
