/** The seeded chats’ transcripts: the main exchange, its HTML artifact and the parked-question flow. */
import { buildAnswerMessage } from '../../../src/shared/lib/agent-questions/answered-questions';
import { FIXTURE_HTML_ARTIFACT_ID, FIXTURE_HTML_ARTIFACT_TITLE } from './base';

const FIXTURE_HTML_ARTIFACT_FLOW_RUN_ID = 'qa-fixture-customer-digest-flow-run';
const FIXTURE_HTML_ARTIFACT_NODE_RUN_ID = 'qa-fixture-customer-digest-node-run';

const FIXTURE_HTML_ARTIFACT_BODY = `
<style>
  :root { color-scheme: light; font-family: Inter, system-ui, sans-serif; background: #f5f3ed; color: #19231f; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #f5f3ed; }
  main { max-width: 760px; margin: auto; padding: 24px; }
  header { margin-bottom: 16px; }
  h1 { margin: 4px 0 6px; font-size: 1.55rem; }
  h2 { margin: 0 0 12px; font-size: 1rem; }
  p { line-height: 1.45; }
  .eyebrow, .muted { margin: 0; color: #63716a; font-size: .78rem; }
  .panel { margin-top: 12px; padding: 16px; border: 1px solid #d6dcd7; border-radius: 14px; background: #fff; }
  .bar { display: grid; grid-template-columns: 110px 1fr 20px; align-items: center; gap: 10px; margin: 9px 0; font-size: .82rem; }
  .track { height: 9px; overflow: hidden; border-radius: 9px; background: #e5eae7; }
  .fill { display: block; height: 100%; background: #187565; }
  .fill.onboarding { width: 50%; background: #a26718; }
  .fill.sync { width: 50%; background: #57758a; }
  label { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; font-size: .8rem; font-weight: 700; }
  select { min-height: 36px; border: 1px solid #71827a; border-radius: 8px; padding: 6px 10px; background: #fff; font: inherit; }
  ol { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
  li { padding: 11px 12px; border: 1px solid #e0e5e2; border-radius: 10px; background: #fbfcfa; }
  li p { margin: 6px 0 0; color: #47564f; font-size: .82rem; }
  .tag { float: right; border-radius: 20px; padding: 3px 7px; background: #e4eee9; color: #2d5c51; font-size: .7rem; font-weight: 700; }
  [hidden] { display: none !important; }
  @media (max-width: 480px) { main { padding: 14px; } .bar { grid-template-columns: 90px 1fr 20px; } }
</style>
<main lang="en" aria-labelledby="digest-title">
  <header>
    <p class="eyebrow">Support review · 18–22 Aug</p>
    <h1 id="digest-title">Customer message digest</h1>
    <p class="muted">Four representative messages, grouped into the three themes shaping this week’s support queue.</p>
  </header>
  <section class="panel" aria-labelledby="themes-title">
    <h2 id="themes-title">Messages by theme</h2>
    <div role="img" aria-label="Billing 2 messages, onboarding 1, sync reliability 1">
      <div class="bar"><span>Billing</span><span class="track"><span class="fill" style="width:100%"></span></span><strong>2</strong></div>
      <div class="bar"><span>Onboarding</span><span class="track"><span class="fill onboarding"></span></span><strong>1</strong></div>
      <div class="bar"><span>Sync reliability</span><span class="track"><span class="fill sync"></span></span><strong>1</strong></div>
    </div>
  </section>
  <section class="panel" aria-labelledby="messages-title">
    <h2 id="messages-title">Customer messages</h2>
    <label for="digest-theme">Filter by theme
      <select id="digest-theme">
        <option value="all">All themes</option>
        <option value="billing">Billing</option>
        <option value="onboarding">Onboarding</option>
        <option value="sync-reliability">Sync reliability</option>
      </select>
    </label>
    <p id="digest-count" class="muted" role="status" aria-live="polite">Showing 4 messages</p>
    <ol>
      <li data-message data-theme="billing"><span class="tag">Billing</span><strong>Northstar Studios</strong><p>Invoice shows 24 seats, but only 12 teammates can sign in.</p></li>
      <li data-message data-theme="billing"><span class="tag">Billing</span><strong>Cedar Lane</strong><p>The annual-plan credit is missing from this month’s invoice.</p></li>
      <li data-message data-theme="onboarding"><span class="tag">Onboarding</span><strong>Nimbus Dental</strong><p>SSO setup is blocking 42 new starters this morning.</p></li>
      <li data-message data-theme="sync-reliability"><span class="tag">Sync reliability</span><strong>Juniper Ops</strong><p>Project changes have not synced for 47 minutes.</p></li>
    </ol>
  </section>
</main>
<script>
  const filter = document.querySelector('#digest-theme');
  const rows = [...document.querySelectorAll('[data-message]')];
  filter.addEventListener('change', () => {
    const visible = rows.filter((row) => {
      row.hidden = filter.value !== 'all' && row.dataset.theme !== filter.value;
      return !row.hidden;
    }).length;
    document.querySelector('#digest-count').textContent = 'Showing ' + visible + (visible === 1 ? ' message' : ' messages');
  });
</script>`.trim();

// A multi-node flow parked at awaiting_input, on ONE sub-chat: the first node's task is `done` and is
// the chat's PINNED task, while a LATER node's task is `needs_attention` and carries the structured
// `awaiting_input` question. This is the exact shape ParkedQuestionsBar must resolve from the DRIVING
// task (not the pinned, terminal one) — the fixture that lets a vision run reach the parked-question
// card. Both tasks are source='flow' (getFlowDriveInfoForSubChat filters on it) with a null flowRunId
// so no flow-run recovery or agent run is ever triggered — the state stays inert and deterministic.
export const FIXTURE_FLOW_CHAT_ID = 'qa-fixture-chat-flow';
export const FIXTURE_FLOW_SUB_CHAT_ID = 'qa-fixture-subchat-flow';
export const FIXTURE_FLOW_TASK_DONE_ID = 'qa-fixture-flow-task-done';
export const FIXTURE_FLOW_TASK_PARKED_ID = 'qa-fixture-flow-task-parked';

/** UIMessage-shaped rows stored in sub_chats.messages (JSON text). */
export const FIXTURE_MESSAGES = [
  {
    id: 'qa-fixture-msg-user-1',
    role: 'user',
    parts: [{ type: 'text', text: 'List the top-level folders in this project.' }],
  },
  {
    id: 'qa-fixture-msg-assistant-1',
    role: 'assistant',
    parts: [
      {
        type: 'text',
        text: 'The project contains src, scripts, docs and relay at the top level.',
      },
    ],
  },
  {
    id: 'qa-fixture-msg-assistant-flow-receipt',
    role: 'assistant',
    parts: [
      {
        type: 'tool-mcp__frink_dynamic_chat__frink_flows_patch',
        toolCallId: 'qa-flow-patch-root',
        state: 'output-available',
        input: {
          name: 'Release intelligence',
          operations: [
            { op: 'add_node', node: { id: 'trigger', blockType: 'manual_trigger' } },
            {
              op: 'add_node',
              node: {
                id: 'draft',
                blockType: 'agent',
                label: 'Draft release',
                config: { instructions: 'QA_PRIVATE_INSTRUCTION_SHOULD_NOT_RENDER' },
              },
            },
            {
              op: 'add_node',
              node: { id: 'review', blockType: 'condition', label: 'Quality gate' },
            },
            {
              op: 'add_node',
              node: { id: 'publish', blockType: 'run_command', label: 'Publish notes' },
            },
            { op: 'add_edge', edge: { id: 'e1', source: 'trigger', target: 'draft' } },
            { op: 'add_edge', edge: { id: 'e2', source: 'draft', target: 'review' } },
            {
              op: 'add_edge',
              edge: { id: 'e3', source: 'review', target: 'publish', sourceHandle: 'true' },
            },
          ],
        },
        result: {
          status: 'success',
          persistence: 'saved',
          flowId: 'qa-fixture-flow-paused',
          name: 'Release intelligence',
          versionNumber: 2,
          graph: {
            nodes: [
              { id: 'trigger', blockType: 'manual_trigger' },
              { id: 'draft', blockType: 'agent', label: 'Draft release' },
              { id: 'review', blockType: 'condition', label: 'Quality gate' },
              { id: 'publish', blockType: 'run_command', label: 'Publish notes' },
            ],
            edges: [
              { id: 'e1', source: 'trigger', target: 'draft' },
              { id: 'e2', source: 'draft', target: 'review' },
              { id: 'e3', source: 'review', target: 'publish', sourceHandle: 'true' },
            ],
          },
          applied: [0, 1, 2, 3, 4, 5, 6],
          failed: [],
          skipped: [],
          flowChange: {
            schemaVersion: 1,
            mode: 'create',
            baseVersionNumber: 1,
            versionNumber: 2,
            changes: [
              {
                operationIndex: 0,
                action: 'add',
                kind: 'node',
                status: 'applied',
                label: 'Manual trigger',
                detail: 'Manual trigger step',
                nodeId: 'trigger',
                blockType: 'manual_trigger',
              },
              {
                operationIndex: 1,
                action: 'add',
                kind: 'node',
                status: 'applied',
                label: 'Draft release',
                detail: 'Agent step',
                nodeId: 'draft',
                blockType: 'agent',
              },
              {
                operationIndex: 2,
                action: 'add',
                kind: 'node',
                status: 'applied',
                label: 'Quality gate',
                detail: 'Condition step',
                nodeId: 'review',
                blockType: 'condition',
              },
              {
                operationIndex: 3,
                action: 'add',
                kind: 'node',
                status: 'applied',
                label: 'Publish notes',
                detail: 'Run command step',
                nodeId: 'publish',
                blockType: 'run_command',
              },
              {
                operationIndex: 4,
                action: 'add',
                kind: 'edge',
                status: 'applied',
                label: 'Manual trigger → Draft release',
                detail: 'Route',
                edgeId: 'e1',
                relatedNodeIds: ['trigger', 'draft'],
              },
              {
                operationIndex: 5,
                action: 'add',
                kind: 'edge',
                status: 'applied',
                label: 'Draft release → Quality gate',
                detail: 'Route',
                edgeId: 'e2',
                relatedNodeIds: ['draft', 'review'],
              },
              {
                operationIndex: 6,
                action: 'add',
                kind: 'edge',
                status: 'applied',
                label: 'Quality gate → Publish notes',
                detail: 'True route',
                edgeId: 'e3',
                relatedNodeIds: ['review', 'publish'],
              },
            ],
          },
        },
      },
      {
        type: 'text',
        text: 'Release intelligence is ready. Open the Flow when you want to tune the prompts or run it.',
      },
    ],
  },
  {
    id: 'qa-fixture-msg-user-customer-digest',
    role: 'user',
    parts: [
      {
        type: 'text',
        text: 'Collate this week’s customer messages into a digest I can review before support stand-up.',
      },
    ],
  },
  {
    id: 'qa-fixture-msg-assistant-customer-digest',
    role: 'assistant',
    metadata: {
      source: 'chat_reply',
      flowRunId: FIXTURE_HTML_ARTIFACT_FLOW_RUN_ID,
      nodeRunId: FIXTURE_HTML_ARTIFACT_NODE_RUN_ID,
    },
    parts: [
      {
        type: 'data-html-artifact',
        data: {
          version: 1,
          artifactId: FIXTURE_HTML_ARTIFACT_ID,
          title: FIXTURE_HTML_ARTIFACT_TITLE,
          bodyHtml: FIXTURE_HTML_ARTIFACT_BODY,
        },
      },
    ],
  },
];

/**
 * The question/answer pair the seeded answer message resolves. Both the model-visible text and the
 * display-only pairs that draw the answer card come from the app's own builder below, so the
 * fixture cannot drift from what a real answer sends.
 */
const FIXTURE_QUESTIONS = [
  { question: 'Which branch should I make these changes on?', header: 'Branch' },
  { question: 'When should the changelog entry be added?', header: 'Changelog' },
];
const FIXTURE_ANSWER_PICKS: Record<string, string> = {
  'Which branch should I make these changes on?': 'Work on the current branch',
  'When should the changelog entry be added?': 'Add an entry before the tests run',
};
const FIXTURE_ANSWER = buildAnswerMessage(FIXTURE_QUESTIONS, FIXTURE_ANSWER_PICKS);
// Null only when nothing was picked, which the constants above rule out — fail loudly rather than
// seeding a blank message the QA rig would then judge.
if (!FIXTURE_ANSWER) throw new Error('qa fixtures: the seeded answer resolved to nothing');

/**
 * Messages for the parked-flow sub-chat — a short exchange ending just before the agent parks.
 * The third message is an ANSWER to an earlier question. Its `metadata.answeredQuestions` is what
 * makes it render as the AnsweredQuestionsCard rather than a bare bubble — the text stays exactly
 * what the agent would read. Text via the app's own formatter so the fixture can't drift from what
 * a real answer sends.
 */
export const FIXTURE_FLOW_MESSAGES = [
  {
    id: 'qa-fixture-flow-msg-user-1',
    role: 'user',
    parts: [
      { type: 'text', text: 'Implement the change, then check with me before running the tests.' },
    ],
  },
  {
    id: 'qa-fixture-flow-msg-assistant-1',
    role: 'assistant',
    parts: [
      {
        type: 'text',
        text: 'Before I start: which branch should I work on, and how should I handle the changelog?',
      },
    ],
  },
  {
    id: 'qa-fixture-flow-msg-user-2',
    role: 'user',
    parts: [{ type: 'text', text: FIXTURE_ANSWER.text }],
    metadata: FIXTURE_ANSWER.metadata,
  },
  {
    id: 'qa-fixture-flow-msg-assistant-2',
    role: 'assistant',
    parts: [
      {
        type: 'text',
        text: 'The code changes are complete. Before I run the test suite I need a decision from you.',
      },
    ],
  },
];

/** The awaiting_input agent signal (with clickable questions) that ParkedQuestionsBar renders. */
export const FIXTURE_PARKED_SIGNAL = {
  state: 'awaiting_input',
  summary: 'The code changes are complete — how should I proceed with the tests?',
  questions: [
    {
      header: 'Next step',
      question: 'How should I proceed with the tests?',
      options: [
        {
          label: 'Run the full test suite',
          description: 'Write the tests and run the whole suite now.',
        },
        { label: 'Skip the tests for now', description: 'Leave the code as-is; run tests later.' },
      ],
      multiSelect: false,
    },
  ],
  at: '2026-01-01T12:00:00.000Z',
};
