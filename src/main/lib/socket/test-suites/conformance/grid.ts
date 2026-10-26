import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_RUNTIMES, type AgentRuntime } from '../../../../../shared/lib/ai-providers';
import { __resetSessionsForTest } from '../../claude-session-registry';
import { APPROVAL_SCENARIOS } from './approvals';
import { EXPECTED_FAILURES, type RowId, type ScenarioId } from './baseline';
import { registerCapabilityRows } from './capabilities';
import { type GridHarness, type Observed, runClaudeWakeBurst, runConformanceTurn } from './drive';
import {
  REPLY,
  type ScenarioFixtures,
  SIMPLE_TURN,
  WRITE_CARDS,
  WRITE_FILE,
  WRITE_PATH,
} from './fixtures';
import { SESSION_SCENARIOS } from './sessions';

type Check = (seen: Observed, runtime: AgentRuntime) => void;

/** Runs as one row per runtime. Its precondition is its own test and never takes `fails`. */
export type Scenario = {
  id: ScenarioId;
  play: (h: GridHarness, runtime: AgentRuntime) => Promise<Observed>;
  /** The runtimes the scenario can happen on; every other cell is skipped with `otherwise`. */
  appliesTo?: { runtimes: readonly AgentRuntime[]; otherwise: string };
  precondition?: { name: string; check: Check };
  check: Check;
};

/** Plays one turn of each runtime's own fixture. */
const once =
  (fixtures: ScenarioFixtures): Scenario['play'] =>
  (h, runtime) =>
    runConformanceTurn(h, runtime, fixtures[runtime].turn);

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

const SCENARIOS: Scenario[] = [
  { id: 'simple-turn', play: once(SIMPLE_TURN), check: expectCleanReply },
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
  ...SESSION_SCENARIOS,
  ...APPROVAL_SCENARIOS,
];

function registerRow(h: GridHarness, scenario: Scenario, runtime: AgentRuntime): void {
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
export function registerConformanceTests(h: GridHarness): void {
  describe('conformance grid: every scenario on every runtime', () => {
    afterEach(() => __resetSessionsForTest());
    for (const scenario of SCENARIOS) {
      for (const runtime of AGENT_RUNTIMES) registerRow(h, scenario, runtime);
    }
    registerCapabilityRows(h);
  });
}
