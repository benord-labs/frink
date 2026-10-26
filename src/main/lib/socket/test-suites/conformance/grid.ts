import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_RUNTIMES, type AgentRuntime } from '../../../../../shared/lib/ai-providers';
import { __resetSessionsForTest } from '../../claude-session-registry';
import type { OperatorReminderHarness } from '../operator-reminders/delivery';
import { EXPECTED_FAILURES, type RowId, type ScenarioId } from './baseline';
import { type Observed, runClaudeWakeBurst, runConformanceTurn, type TurnSetup } from './drive';
import {
  LINKED_PROJECT,
  REPLY,
  type ScenarioFixtures,
  SIMPLE_TURN,
  WORKTREE,
  WRITE_CARDS,
  WRITE_FILE,
  WRITE_PATH,
} from './fixtures';

type Check = (seen: Observed, runtime: AgentRuntime) => void;

/** Runs as one row per runtime. Its precondition is its own test and never takes `fails`. */
type Scenario = {
  id: ScenarioId;
  play: (h: OperatorReminderHarness, runtime: AgentRuntime) => Promise<Observed>;
  /** The runtimes the scenario can happen on; every other cell is skipped with `otherwise`. */
  appliesTo?: { runtimes: readonly AgentRuntime[]; otherwise: string };
  precondition?: { name: string; check: Check };
  check: Check;
};

const LINK_NOTE = 'Projects linked to this chat';
/** The note a typed message's open editor file adds. */
const OPEN_FILE_NOTE = 'The user opened the file a.ts in the IDE.';
const PERSON: TurnSetup['delivery'] = { messageOrigin: { source: 'person', kind: 'message' } };

/** Plays one turn of each runtime's own fixture, in a chat set up as `setup` says. */
const once =
  (fixtures: ScenarioFixtures, setup?: TurnSetup): Scenario['play'] =>
  (h, runtime) =>
    runConformanceTurn(h, runtime, fixtures[runtime].turn, setup);

function expectCleanReply(seen: Observed): void {
  const text = seen.chunks.flatMap((chunk) => (chunk.type === 'text-delta' ? [chunk.delta] : []));
  expect(text.join('')).toBe(REPLY);
  expect(seen.chunks).toContainEqual(expect.objectContaining({ type: 'finish' }));
  expect(seen.errors).toEqual([]);
  expect(seen.completed).toBe(true);
}

function expectWriteCard(seen: Observed, runtime: AgentRuntime): void {
  const card = WRITE_CARDS[runtime];
  expect(seen.chunks).toContainEqual({ type: 'tool-input-available', ...card });
  expect(seen.chunks).toContainEqual(
    expect.objectContaining({ type: 'tool-output-available', toolCallId: card.toolCallId }),
  );
}

function expectFileChanged(seen: Observed): void {
  expect(seen.fileChanged).toContainEqual(
    expect.objectContaining({ filePath: WRITE_PATH, subChatId: seen.subChatId }),
  );
}

/** A plain reply that carries no link note. */
function expectPlainTurn(seen: Observed): void {
  expectCleanReply(seen);
  expect(seen.notes.join('\n')).not.toContain(LINK_NOTE);
}

function expectLinkNote(seen: Observed): void {
  const notes = seen.notes.join('\n');
  expect(notes).toContain(LINK_NOTE);
  expect(notes).toContain(`): ${LINKED_PROJECT.name} — ${LINKED_PROJECT.path}.`);
}

/** The agent's folder is the worktree, not the main checkout its permissions are judged against. */
function expectWorktreeLinkNote(seen: Observed): void {
  expectLinkNote(seen);
  expect(seen.notes.join('\n')).toContain(`your working folder stays ${WORKTREE.path})`);
}

/** The typed message's own note rides too, after the link note, so Claude's cap cuts it first. */
function expectLinkNoteFirst(seen: Observed): void {
  expectLinkNote(seen);
  const notes = seen.notes.join('\n');
  expect(notes).toContain(OPEN_FILE_NOTE);
  expect(notes.indexOf(LINK_NOTE)).toBeLessThan(notes.indexOf(OPEN_FILE_NOTE));
}

const SCENARIOS: Scenario[] = [
  { id: 'simple-turn', play: once(SIMPLE_TURN), check: expectPlainTurn },
  {
    id: 'write-file-changed',
    play: once(WRITE_FILE),
    precondition: { name: 'the write card reached the stream', check: expectWriteCard },
    check: expectFileChanged,
  },
  {
    id: 'write-in-wake-burst',
    appliesTo: {
      runtimes: ['claude'],
      otherwise: 'Only Claude keeps its CLI open between turns for background work.',
    },
    play: (h) => runClaudeWakeBurst(h, WRITE_FILE.claude.turn),
    precondition: { name: 'the write card reached the stream', check: expectWriteCard },
    check: expectFileChanged,
  },
  {
    id: 'linked-projects-note',
    // A flow's message in a worktree chat: the note is Frink's own, so it rides turns no person
    // typed too, and it names the folder the agent works in.
    play: once(SIMPLE_TURN, {
      worktree: WORKTREE,
      links: [LINKED_PROJECT],
      delivery: { messageOrigin: { source: 'flow', kind: 'message' } },
    }),
    check: expectWorktreeLinkNote,
  },
  {
    id: 'linked-projects-typed',
    play: once(SIMPLE_TURN, {
      links: [LINKED_PROJECT],
      message: '@[file:editor:a.ts] go',
      delivery: PERSON,
    }),
    check: expectLinkNoteFirst,
  },
  {
    id: 'linked-projects-compact',
    // A `/compact` goes out bare, so no note becomes its summary instructions.
    play: once(SIMPLE_TURN, { links: [LINKED_PROJECT], message: '/compact', delivery: PERSON }),
    check: expectPlainTurn,
  },
];

function registerRow(h: OperatorReminderHarness, scenario: Scenario, runtime: AgentRuntime): void {
  const row: RowId = `${scenario.id} x ${runtime}`;
  if (scenario.appliesTo && !scenario.appliesTo.runtimes.includes(runtime)) {
    it.skip(`conformance: ${row} (n/a: ${scenario.appliesTo.otherwise})`);
    return;
  }
  const run = () => scenario.play(h, runtime);
  const { precondition } = scenario;
  if (precondition) {
    it(`conformance: ${row} (precondition: ${precondition.name})`, async () => {
      precondition.check(await run(), runtime);
    });
  }
  it(`conformance: ${row}`, { fails: row in EXPECTED_FAILURES }, async () => {
    scenario.check(await run(), runtime);
  });
}

/** The scenario x runtime parity grid, each row run through handleRemoteExecute.
 * Registered from executor.test.ts, whose module mocks it relies on. */
export function registerConformanceTests(h: OperatorReminderHarness): void {
  describe('conformance grid: every scenario on every runtime', () => {
    afterEach(() => __resetSessionsForTest());
    for (const scenario of SCENARIOS) {
      for (const runtime of AGENT_RUNTIMES) registerRow(h, scenario, runtime);
    }
  });
}
