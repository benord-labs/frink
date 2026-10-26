import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_RUNTIMES, type AgentRuntime } from '../../../../../shared/lib/ai-providers';
import { __resetSessionsForTest } from '../../claude-session-registry';
import type { OperatorReminderHarness } from '../operator-reminders/delivery';
import { EXPECTED_FAILURES, type RowId, type ScenarioId } from './baseline';
import { type Observed, runConformanceTurn } from './drive';
import {
  REPLY,
  type ScenarioFixtures,
  SIMPLE_TURN,
  WRITE_CARDS,
  WRITE_FILE,
  WRITE_PATH,
} from './fixtures';

type Check = (seen: Observed, runtime: AgentRuntime) => void;

/** Runs as one row per runtime. Its precondition is its own test and never takes `fails`. */
type Scenario = {
  id: ScenarioId;
  fixtures: ScenarioFixtures;
  precondition?: { name: string; check: Check };
  check: Check;
};

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
  { id: 'simple-turn', fixtures: SIMPLE_TURN, check: expectCleanReply },
  {
    id: 'write-file-changed',
    fixtures: WRITE_FILE,
    precondition: { name: 'the write card reached the stream', check: expectWriteCard },
    check: expectFileChanged,
  },
];

function registerRow(h: OperatorReminderHarness, scenario: Scenario, runtime: AgentRuntime): void {
  const row: RowId = `${scenario.id} x ${runtime}`;
  const run = () => runConformanceTurn(h, runtime, scenario.fixtures[runtime].turn);
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
