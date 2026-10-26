import { expect } from 'vitest';
import { AGENT_RUNTIMES } from '../../../../../shared/lib/ai-providers';
import type { ChatMode } from '../../../../../shared/types/chat-mode';
import { retireRetainedSession } from '../../claude-session-registry';
import { PLAN_MODE_EXIT_REMINDER } from '../../operator-reminders';
import { type Observed, startRow } from './drive';
import { PARTIAL, SESSION_ID, SIMPLE_TURN, STOPPED_TURN, WRITE_CARDS } from './fixtures';
import type { Scenario } from './grid';

type Step = { mode?: ChatMode; stopped?: boolean };

/** Turns on one sub-chat, in order; each after the first resumes the session the last stored. */
function turns(...steps: Step[]): Scenario['play'] {
  return async (h, runtime) => {
    const row = startRow(h, runtime);
    for (const [index, { mode, stopped }] of steps.entries()) {
      // Retiring Claude's idle CLI makes every runtime resume from its stored id.
      if (index > 0) retireRetainedSession(row.subChatId, 'conformance sweep');
      await row.turn((stopped ? STOPPED_TURN : SIMPLE_TURN)[runtime].turn, {
        mode,
        sessionId: row.storedSession(),
        stopAfter: stopped ? PARTIAL : undefined,
      });
    }
    return row.observe();
  };
}

const resumed = (count: number) => ({
  name: 'each later turn resumed the session the first stored',
  check: (seen: Observed) =>
    expect(seen.inputs.map((turn) => turn.resumedFrom)).toEqual([
      undefined,
      ...Array<string>(count).fill(SESSION_ID),
    ]),
});

const toldLast = (seen: Observed) => seen.inputs.at(-1)?.told;

const partialStreamed = {
  name: 'the reply before Stop reached the stream',
  check: (seen: Observed) =>
    expect(seen.chunks).toContainEqual(expect.objectContaining({ delta: PARTIAL })),
};

const stopThenResume = turns({ stopped: true }, {});

const PLAN_RUNTIMES: Scenario['appliesTo'] = {
  runtimes: AGENT_RUNTIMES.filter((runtime) => runtime !== 'codex'),
  otherwise: 'Codex refuses a Plan turn before it starts, so no plan reaches its transcript.',
};

export const SESSION_SCENARIOS: Scenario[] = [
  {
    id: 'resumed-mode-kept',
    play: turns({ mode: 'agent' }, {}),
    precondition: resumed(1),
    check: (seen) => expect(toldLast(seen)).not.toContain(PLAN_MODE_EXIT_REMINDER),
  },
  {
    id: 'plan-exit-reminder',
    appliesTo: PLAN_RUNTIMES,
    play: turns({ mode: 'plan' }, {}),
    precondition: resumed(1),
    check: (seen) => expect(toldLast(seen)).toContain(PLAN_MODE_EXIT_REMINDER),
  },
  {
    id: 'stopped-plan-exit-reminder',
    appliesTo: PLAN_RUNTIMES,
    play: turns({}, { mode: 'plan', stopped: true }, {}),
    precondition: resumed(2),
    check: (seen) => expect(toldLast(seen)).toContain(PLAN_MODE_EXIT_REMINDER),
  },
  {
    id: 'stop-mid-turn',
    play: stopThenResume,
    precondition: partialStreamed,
    check: (seen, runtime) => {
      const afterStop = WRITE_CARDS[runtime].toolCallId;
      expect(seen.chunks).not.toContainEqual(expect.objectContaining({ toolCallId: afterStop }));
      expect(seen.errors).toEqual([]);
      const end = seen.inputs[0]?.end;
      expect({ stopped: end?.stopped, closed: end?.closed }).toEqual({
        stopped: true,
        closed: true,
      });
    },
  },
  {
    id: 'stop-keeps-partial',
    play: stopThenResume,
    precondition: partialStreamed,
    check: (seen) => expect(seen.savedText).toContain(PARTIAL),
  },
  {
    id: 'resume-after-stop',
    play: stopThenResume,
    precondition: partialStreamed,
    check: resumed(1).check,
  },
];
