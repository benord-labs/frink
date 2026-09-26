import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readTranscript } from './reader';
import {
  type CodexState,
  initialCodexState,
  parseClaudeLine,
  parseCodexLine,
  parseCodexOrigin,
  type UsageRecord,
} from './transcripts';

const AT = '2026-09-23T09:00:00.000Z';

function claudeLine(overrides: {
  usage?: Record<string, number>;
  content?: unknown[];
  id?: string;
  requestId?: string;
  model?: string;
  timestamp?: string;
  type?: string;
}): string {
  const { usage, content, id, requestId, model, timestamp, type } = overrides;
  return JSON.stringify({
    type: type ?? 'assistant',
    timestamp: timestamp ?? AT,
    requestId,
    message: {
      id,
      model: model ?? 'claude-opus-5',
      usage: usage ?? { input_tokens: 12, output_tokens: 40 },
      content: content ?? [],
    },
  });
}

const toolUse = (name: string, input: unknown = {}) => ({ type: 'tool_use', name, input });

describe('parseClaudeLine', () => {
  it('counts new input and output, never cache reads or writes', () => {
    const record = parseClaudeLine(
      claudeLine({
        usage: {
          input_tokens: 3,
          output_tokens: 50,
          cache_read_input_tokens: 90_000,
          cache_creation_input_tokens: 4_000,
        },
      }),
    );
    expect(record).toMatchObject({
      provider: 'claude',
      model: 'claude-opus-5',
      timestampMs: Date.parse(AT),
      inputTokens: 3,
      outputTokens: 50,
    });
  });

  it('reads missing or negative token counts as 0', () => {
    const record = parseClaudeLine(claudeLine({ usage: { input_tokens: -5 } }));
    expect(record).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });

  it('keys a response by message and request id, and leaves it unkeyed without either', () => {
    expect(parseClaudeLine(claudeLine({ id: 'msg_1', requestId: 'req_1' }))?.dedupeKey).toBe(
      'msg_1:req_1',
    );
    expect(parseClaudeLine(claudeLine({ id: 'msg_1' }))?.dedupeKey).toBe('msg_1:');
    expect(parseClaudeLine(claudeLine({}))?.dedupeKey).toBeNull();
  });

  it('lists skills and MCP servers, leaving out Frink plumbing and other tools', () => {
    const record = parseClaudeLine(
      claudeLine({
        content: [
          toolUse('Skill', { skill: 'commit-gates' }),
          toolUse('mcp__shortcut__stories-search'),
          toolUse('mcp__frink_dynamic_chat__frink_flows_run'),
          toolUse('Bash', { command: 'ls' }),
          toolUse('Skill', {}),
          { type: 'text', text: 'mcp__notion__search' },
        ],
      }),
    );
    expect(record?.tools).toEqual(['skill:commit-gates', 'mcp:shortcut']);
  });

  it('yields nothing for other lines, malformed JSON, a missing model or a bad timestamp', () => {
    expect(parseClaudeLine(claudeLine({ type: 'user' }))).toBeNull();
    expect(parseClaudeLine('{"type":"assistant",')).toBeNull();
    expect(parseClaudeLine(claudeLine({ model: '' }))).toBeNull();
    expect(parseClaudeLine(claudeLine({ timestamp: 'yesterday' }))).toBeNull();
  });
});

// UUIDv7 ids: the fork below is created after the parent turn and before its own turn.
const PARENT_TURN = '019fa000-0000-7000-8000-000000000001';
const FORK_ID = '019fb000-0000-7000-8000-000000000002';
const OWN_TURN = '019fb000-1000-7000-8000-000000000003';

function codexLine(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ type, timestamp: AT, payload });
}

function tokenCount(input: number, cached: number, output: number, total: number): string {
  const usage = { input_tokens: input, cached_input_tokens: cached, output_tokens: output };
  return codexLine('event_msg', {
    type: 'token_count',
    info: { last_token_usage: usage, total_token_usage: { total_tokens: total } },
  });
}

function parseCodex(lines: string[], state: CodexState = initialCodexState()): UsageRecord[] {
  return lines.flatMap((line, i) => parseCodexLine(line, state, i === 0) ?? []);
}

describe('parseCodexLine', () => {
  it('attributes usage to the current turn model and subtracts cached input', () => {
    const records = parseCodex([
      codexLine('session_meta', { id: FORK_ID, originator: 'frink' }),
      tokenCount(100, 0, 10, 110),
      codexLine('turn_context', { turn_id: OWN_TURN, model: 'gpt-6-sol' }),
      tokenCount(1_000, 800, 30, 1_140),
      codexLine('event_msg', { type: 'token_count', info: null }),
      codexLine('turn_context', { turn_id: OWN_TURN, model: 'gpt-6-terra' }),
      tokenCount(900, 900, 0, 2_040),
      tokenCount(500, 700, 5, 2_545),
    ]);
    expect(records).toEqual([
      expect.objectContaining({ model: 'gpt-6-sol', inputTokens: 200, outputTokens: 30 }),
      expect.objectContaining({ model: 'gpt-6-terra', inputTokens: 0, outputTokens: 5 }),
    ]);
    expect(records.every((r) => r.provider === 'codex' && r.dedupeKey === null)).toBe(true);
  });

  it('counts a token_count repeated back to back once', () => {
    const records = parseCodex([
      codexLine('turn_context', { model: 'gpt-6-sol' }),
      tokenCount(100, 0, 10, 110),
      codexLine('response_item', { type: 'reasoning' }),
      tokenCount(100, 0, 10, 110),
      tokenCount(100, 0, 10, 220),
    ]);
    expect(records).toHaveLength(2);
  });

  it("skips a fork's replayed ancestor history but counts its own first turn", () => {
    const records = parseCodex([
      codexLine('session_meta', {
        id: FORK_ID,
        forked_from_id: 'parent',
        source: { subagent: {} },
      }),
      codexLine('session_meta', { id: 'parent-id' }),
      codexLine('turn_context', { turn_id: PARENT_TURN, model: 'gpt-6-sol' }),
      tokenCount(5_000, 0, 400, 5_400),
      tokenCount(6_000, 5_000, 300, 11_700),
      codexLine('turn_context', { turn_id: OWN_TURN, model: 'gpt-6-sol' }),
      tokenCount(200, 100, 7, 307),
    ]);
    expect(records).toEqual([expect.objectContaining({ inputTokens: 100, outputTokens: 7 })]);
  });

  it('skips replayed usage that arrives before any turn_context', () => {
    const records = parseCodex([
      codexLine('session_meta', { id: FORK_ID, forked_from_id: 'parent' }),
      tokenCount(5_000, 0, 400, 5_400),
      codexLine('turn_context', { turn_id: OWN_TURN, model: 'gpt-6-sol' }),
      tokenCount(200, 100, 7, 307),
    ]);
    expect(records.map((r) => r.outputTokens)).toEqual([7]);
  });
});

describe('parseCodexOrigin', () => {
  it('judges Frink and subagent rollouts from the session_meta line', () => {
    expect(parseCodexOrigin(codexLine('session_meta', { originator: 'frink' }))).toEqual({
      fromFrink: true,
      subagent: false,
    });
    const spawned = codexLine('session_meta', {
      originator: 'frink',
      source: { subagent: { thread_spawn: { parent_thread_id: 'p' } } },
    });
    expect(parseCodexOrigin(spawned)).toEqual({ fromFrink: true, subagent: true });
    expect(parseCodexOrigin(codexLine('session_meta', { source: 'vscode' }))).toEqual({
      fromFrink: false,
      subagent: false,
    });
    expect(parseCodexOrigin(codexLine('turn_context', { model: 'x' }))).toEqual({
      fromFrink: false,
      subagent: false,
    });
  });
});

describe('readTranscript (Codex)', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'usage-transcripts-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('resumes mid-rollout with the model and replay state it had reached', async () => {
    const path = join(dir, 'rollout.jsonl');
    writeFileSync(
      path,
      [
        codexLine('session_meta', { id: FORK_ID, forked_from_id: 'parent' }),
        codexLine('turn_context', { turn_id: OWN_TURN, model: 'gpt-6-sol' }),
        tokenCount(100, 0, 10, 110),
        '',
      ].join('\n'),
    );
    const first = await readTranscript(path, 'codex');
    expect(first?.records).toHaveLength(1);
    appendFileSync(path, `${tokenCount(100, 0, 10, 110)}\n${tokenCount(300, 100, 20, 430)}\n`);
    const resumed = await readTranscript(path, 'codex', first?.position);
    expect(resumed?.resumed).toBe(true);
    expect(resumed?.records).toEqual([
      expect.objectContaining({ model: 'gpt-6-sol', inputTokens: 200, outputTokens: 20 }),
    ]);
  });
});
