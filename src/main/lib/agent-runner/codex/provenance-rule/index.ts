import log from 'electron-log';
import { z } from 'zod';
import {
  MESSAGE_PROVENANCE_RULE,
  type MessageProvenance,
} from '../../../../../shared/lib/message-markers/message-provenance';
import { captureMainException } from '../../../sentry/init';
import { type CodexAppServerClient, withTimeout } from '../app-server-client';

/**
 * How a thread holds the rule. `durable`: in its developer instructions, which survive compaction.
 * Otherwise it rode a turn's context, which compaction drops and Codex re-injects only when changed.
 */
type RuleState = 'durable' | Carried;
/** `known`: the model holds the rule. `retained`: Codex kept our copy from the latest turn. */
type Carried = {
  known: boolean;
  retained: boolean;
  compactions: number;
  /** Turns and steers in the order they were sent, and the newest one Codex has accepted. */
  sent: number;
  accepted: number;
};
type RuleClient = Pick<CodexAppServerClient, 'sendRequest'>;

const threadRules = new WeakMap<RuleClient, Map<string, RuleState>>();

function ruleStates(client: RuleClient): Map<string, RuleState> {
  const states = threadRules.get(client) ?? new Map<string, RuleState>();
  threadRules.set(client, states);
  return states;
}

/** A local RPC: long enough for a busy app-server, short enough not to stall the turn behind it. */
const CONFIG_READ_TIMEOUT_MS = 3000;

const configRead = z.object({
  config: z.object({ developer_instructions: z.string().nullish() }),
});

/**
 * Developer instructions for a fresh Flow thread: the configured ones, then the rule. Codex takes a
 * request's value over the configured one, so the rule alone would replace the user's own.
 */
export async function developerInstructions(
  client: RuleClient,
  turn: { cwd: string; messageProvenance?: MessageProvenance },
): Promise<string | undefined> {
  if (!turn.messageProvenance) return undefined;
  try {
    const request = client.sendRequest('config/read', { cwd: turn.cwd });
    const read = configRead.parse(
      await withTimeout(request, CONFIG_READ_TIMEOUT_MS, 'Codex config/read timed out'),
    );
    const configured = read.config.developer_instructions?.trim();
    return configured ? `${configured}\n\n${MESSAGE_PROVENANCE_RULE}` : MESSAGE_PROVENANCE_RULE;
  } catch (err) {
    // Unknown configured instructions must not be overwritten: the rule rides the first turn instead.
    log.warn('[Codex] config/read failed; sending the provenance rule with the first record', {
      error: err instanceof Error ? err.message : String(err),
    });
    captureMainException(err, { surface: 'codex-provenance-rule-config' });
    return undefined;
  }
}

export function markDurable(client: RuleClient, threadId: string): void {
  ruleStates(client).set(threadId, 'durable');
}

/** The thread's tracked state, or null when its rule is durable and needs no tracking. */
function carried(client: RuleClient, threadId: string): Carried | null {
  const states = ruleStates(client);
  const state = states.get(threadId) ?? {
    known: false,
    retained: false,
    compactions: 0,
    sent: 0,
    accepted: 0,
  };
  if (state === 'durable') return null;
  states.set(threadId, state);
  return state;
}

/** One turn's decision: whether it carries the rule, and how to record it once Codex accepted it. */
export type RuleTurn = { carriesRule: boolean; settle: () => void };

/**
 * Decide whether the turn about to start carries the rule. `settle` records it once Codex accepted
 * the turn, so a failed start changes nothing and the retry carries the rule again.
 */
export function beginTurn(client: RuleClient, threadId: string, tagged: boolean): RuleTurn {
  const state = carried(client, threadId);
  if (!state) return { carriesRule: false, settle: () => {} };
  const carriesRule = tagged && !state.known && !state.retained;
  const compactionsAtStart = state.compactions;
  const order = (state.sent += 1);
  return {
    carriesRule,
    settle: () => {
      // Codex retains the context of the newest turn it accepted; an older one settling late
      // changes nothing.
      if (order > state.accepted) {
        state.accepted = order;
        state.retained = carriesRule;
      }
      // A compaction that raced the start may already have dropped the rule: leave it unknown.
      if (carriesRule) state.known = state.compactions === compactionsAtStart;
    },
  };
}

/** A steer replaces the context Codex retains, just as a turn does, and never carries the rule. */
export function recordSteer(client: RuleClient, threadId: string): void {
  const state = carried(client, threadId);
  if (!state) return;
  state.accepted = state.sent += 1;
  state.retained = false;
}

/** Matches the `item/completed` notification that reports the thread's context compaction. */
export const compaction = z.object({ item: z.object({ type: z.literal('contextCompaction') }) });

/** A compaction drops a rule that rode a turn's context, so the next eligible turn restates it. */
export function forgetOnCompaction(client: RuleClient, threadId: string): void {
  const state = carried(client, threadId);
  if (!state) return;
  state.known = false;
  state.compactions += 1;
}
