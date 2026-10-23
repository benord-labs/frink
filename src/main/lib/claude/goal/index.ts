import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { GoalPartData } from '../../../../shared/types/goal';
import type { UIMessageChunk } from '../types';

type ContentBlock = { type: string; text?: string };

/** The fields of an SDK frame a goal is read from. */
export type GoalFrame =
  | {
      type: 'assistant';
      parent_tool_use_id: string | null;
      message: { model: string; content: ContentBlock[] };
    }
  | {
      type: 'user';
      parent_tool_use_id: string | null;
      isSynthetic?: boolean;
      message: { content: string | ContentBlock[] };
    }
  | { type: Exclude<SDKMessage['type'], 'assistant' | 'user'> };

const GOAL_SET = 'Goal set: ';
const GOAL_ACTIVE =
  /^Goal active: ([\s\S]+?) \((?:not yet evaluated|\d+ turns?)\)(?:\s*Last check: ([\s\S]*))?$/;
const GOAL_GONE = ['Goal cleared: ', 'No goal set'];
const FEEDBACK = 'Stop hook feedback:';

/** `data-goal` parts read from `/goal`'s synthetic replies and the evaluator's Stop-hook feedback
 * (`active_goal` only reaches remote sessions): one for the turn's goal, one per checked objective,
 * and one per result saying whether that stop deferred the check. */
export function createGoalMapper(
  defersGoalCheck: () => boolean = () => false,
): (msg: GoalFrame) => UIMessageChunk[] {
  const id = `goal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let current: GoalPartData | null = null;
  let stops = 0;
  return (msg) => {
    if (msg.type === 'result') {
      const data: GoalPartData = { state: 'stopped', deferred: defersGoalCheck() };
      return [{ type: 'data-goal', id: `${id}:stop-${stops++}`, data }];
    }
    const next = nextGoal(current, msg);
    if (!next) return [];
    if (next.state === 'checked')
      return [{ type: 'data-goal', id: `${id}:${next.objective}`, data: next }];
    current = next;
    return [{ type: 'data-goal', id, data: next }];
  };
}

function nextGoal(current: GoalPartData | null, msg: GoalFrame): GoalPartData | null {
  if (msg.type === 'assistant') {
    if (msg.parent_tool_use_id || msg.message.model !== '<synthetic>') return null;
    return commandReply(textOf(msg.message.content));
  }
  if (msg.type !== 'user' || msg.parent_tool_use_id || !msg.isSynthetic) return null;
  const text = textOf(msg.message.content);
  return text.startsWith(FEEDBACK)
    ? feedbackGoal(current, text.slice(FEEDBACK.length).trimStart())
    : null;
}

function commandReply(text: string): GoalPartData | null {
  if (text.startsWith(GOAL_SET)) {
    return { state: 'active', objective: text.slice(GOAL_SET.length).trim() };
  }
  if (GOAL_GONE.some((prefix) => text.startsWith(prefix))) return { state: 'cleared' };
  const active = GOAL_ACTIVE.exec(text);
  if (!active) return null;
  return { state: 'active', objective: active[1], lastCheck: active[2]?.trim() || undefined };
}

/** Any Stop hook's feedback reads `[name]: reason`; only the running goal's own objective counts. */
function feedbackGoal(current: GoalPartData | null, body: string): GoalPartData | null {
  if (current?.state === 'active') {
    const prefix = `[${current.objective}]: `;
    return body.startsWith(prefix)
      ? { ...current, lastCheck: body.slice(prefix.length).trim() }
      : null;
  }
  const match = /^\[([\s\S]+?)\]: ([\s\S]*)$/.exec(body);
  return match ? { state: 'checked', objective: match[1], lastCheck: match[2].trim() } : null;
}

function textOf(content: string | ContentBlock[]): string {
  const text = Array.isArray(content)
    ? content.map((block) => (block.type === 'text' ? block.text : '')).join('')
    : content;
  return text.trim();
}
