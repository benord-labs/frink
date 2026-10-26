import path from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SessionEvent } from '@github/copilot-sdk';
import type { AgentRuntime } from '../../../../../shared/lib/ai-providers';
import { type RecordedTurn, says as acpSays } from '../../../agent-runner/acp/acp-test-fixtures';
import type { mapNotificationToChunks } from '../../../agent-runner/codex/codex-events';
import {
  says as copilotSays,
  toolEnds,
  toolStarts,
} from '../../../agent-runner/copilot/copilot-test-fixtures';
import type { CursorSdkMessage } from '../../../agent-runner/cursor/cursor-events';
import { sdk as cursor } from '../../../agent-runner/cursor/cursor-test-fixtures';
import type { UIMessageChunk } from '../../../claude/types';

/** One Codex app-server notification, as the Codex translator takes it. */
type CodexNotification = Parameters<typeof mapNotificationToChunks>;

/** What each runtime's own translator reads for one turn, in that vendor's message types. */
export type VendorTurns = {
  claude: SDKMessage[];
  codex: CodexNotification[];
  acp: RecordedTurn;
  copilot: SessionEvent[];
  cursor: CursorSdkMessage[];
};

/** RECORDED: teed from a real-binary admission run. SCRIPTED: written by hand in vendor shapes. */
type Fixture<R extends AgentRuntime> = {
  source: 'RECORDED' | 'SCRIPTED';
  turn: VendorTurns[R];
};
export type ScenarioFixtures = { [R in AgentRuntime]: Fixture<R> };

/** The card a runtime's translator shows for the scenario's write. */
type WriteCard = Pick<
  Extract<UIMessageChunk, { type: 'tool-input-available' }>,
  'toolCallId' | 'toolName' | 'input'
>;

export const REPLY = 'All done.';
const SESSION_ID = 'sess-conformance';
const NOTE = 'hello';
export const WRITE_PATH = path.resolve('/workspace/project', 'notes.md');
const WRITE_ID = 'call-write';

// SAFETY: the transformer and the Claude session loop read only these fields of an SDK frame.
export const CLAUDE_REPLY = [
  {
    type: 'assistant',
    parent_tool_use_id: null,
    message: { content: [{ type: 'text', text: REPLY }] },
  },
  { type: 'result', subtype: 'success', is_error: false, result: REPLY, session_id: SESSION_ID },
] as SDKMessage[];

// SAFETY: the transformer and the Claude session loop read only these fields of an SDK frame.
const CLAUDE_WRITE = [
  {
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      content: [
        {
          type: 'tool_use',
          id: WRITE_ID,
          name: 'Write',
          input: { file_path: WRITE_PATH, content: NOTE },
        },
      ],
    },
  },
  {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: WRITE_ID, content: 'Written' }],
    },
  },
  { type: 'result', subtype: 'success', is_error: false, result: '', session_id: SESSION_ID },
] as SDKMessage[];

const CODEX_TURN_DONE: CodexNotification = ['turn/completed', { turn: { status: 'completed' } }];
const CODEX_CHANGES = [{ path: WRITE_PATH, kind: { type: 'add' }, diff: NOTE }];
const CODEX_FILE_CHANGE = { type: 'fileChange', id: WRITE_ID, changes: CODEX_CHANGES };

/** A text reply and a clean end, on every runtime: the grid's positive control. */
export const SIMPLE_TURN: ScenarioFixtures = {
  claude: { source: 'SCRIPTED', turn: CLAUDE_REPLY },
  codex: {
    source: 'SCRIPTED',
    turn: [
      ['item/agentMessage/delta', { itemId: 'msg-1', delta: REPLY }],
      ['item/completed', { item: { type: 'agentMessage', id: 'msg-1', text: REPLY } }],
      CODEX_TURN_DONE,
    ],
  },
  acp: {
    source: 'SCRIPTED',
    turn: { messages: [{ update: acpSays(REPLY) }], response: { stopReason: 'end_turn' } },
  },
  copilot: { source: 'SCRIPTED', turn: [copilotSays(REPLY)] },
  cursor: { source: 'SCRIPTED', turn: [cursor.says(REPLY)] },
};

/** The agent writes one file. Every recorded ACP write was rejected, so ACP's is scripted. */
export const WRITE_FILE: ScenarioFixtures = {
  claude: { source: 'SCRIPTED', turn: CLAUDE_WRITE },
  codex: {
    source: 'SCRIPTED',
    turn: [
      ['item/started', { item: { ...CODEX_FILE_CHANGE, status: 'inProgress' } }],
      ['item/completed', { item: { ...CODEX_FILE_CHANGE, status: 'completed' } }],
      CODEX_TURN_DONE,
    ],
  },
  acp: {
    source: 'SCRIPTED',
    turn: {
      messages: [
        {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: WRITE_ID,
            title: 'write',
            kind: 'edit',
            status: 'pending',
            locations: [{ path: WRITE_PATH }],
            rawInput: { filePath: WRITE_PATH, content: NOTE },
          },
        },
        {
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: WRITE_ID,
            status: 'completed',
            content: [{ type: 'diff', path: WRITE_PATH, oldText: '', newText: NOTE }],
          },
        },
      ],
      response: { stopReason: 'end_turn' },
    },
  },
  copilot: {
    source: 'SCRIPTED',
    turn: [
      toolStarts(WRITE_ID, 'create', { path: WRITE_PATH, file_text: NOTE }),
      toolEnds(WRITE_ID, true, 'Created file'),
    ],
  },
  cursor: {
    source: 'SCRIPTED',
    turn: [
      cursor.runs(WRITE_ID, 'edit', { path: WRITE_PATH }),
      cursor.ran(
        WRITE_ID,
        'edit',
        { path: WRITE_PATH },
        { status: 'success', value: { diffString: `+${NOTE}` } },
      ),
    ],
  },
};

const EDIT_CARD = { toolCallId: WRITE_ID, toolName: 'Edit' };

/** Each translator's card for the write. Codex names the file in `changes`, not in `file_path`. */
export const WRITE_CARDS: Record<AgentRuntime, WriteCard> = {
  claude: {
    toolCallId: WRITE_ID,
    toolName: 'Write',
    input: { file_path: WRITE_PATH, content: NOTE },
  },
  codex: { ...EDIT_CARD, input: { changes: CODEX_CHANGES } },
  acp: { ...EDIT_CARD, input: { file_path: WRITE_PATH, old_string: '', new_string: NOTE } },
  copilot: { ...EDIT_CARD, input: { file_path: WRITE_PATH, old_string: '', new_string: NOTE } },
  cursor: { ...EDIT_CARD, input: { file_path: WRITE_PATH } },
};
