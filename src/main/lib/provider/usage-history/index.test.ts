import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getUsageHistory, resetUsageHistoryForTests, usageHistoryDeps } from './index';
import { listTranscriptFiles, readCodexOrigin, readTranscript } from './reader';

let root = '';
let clock = 0;
const NOW = new Date(2026, 8, 23, 15, 0);

function claudeTurn(id: string, output: number): string {
  return `${JSON.stringify({
    type: 'assistant',
    timestamp: new Date(2026, 8, 23, 9, 0).toISOString(),
    requestId: `req_${id}`,
    message: {
      id,
      model: 'claude-opus-5',
      usage: { input_tokens: 0, output_tokens: output },
      content: [],
    },
  })}\n`;
}

function codexRollout(originator: string, output: number): string {
  type Payload = {
    originator?: string;
    model?: string;
    type?: string;
    info?: { last_token_usage: { input_tokens: number; output_tokens: number } };
  };
  const line = (type: string, payload: Payload, second: number) =>
    `${JSON.stringify({ type, timestamp: new Date(2026, 8, 23, 9, 0, second).toISOString(), payload })}\n`;
  return (
    line('session_meta', { originator }, 0) +
    line('turn_context', { model: 'gpt-6-sol' }, 1) +
    line(
      'event_msg',
      {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 0, output_tokens: output } },
      },
      5,
    )
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'usage-history-'));
  clock = NOW.getTime();
  usageHistoryDeps.claudeRoot = () => join(root, 'claude-sessions');
  usageHistoryDeps.codexRoot = () => join(root, 'codex');
  usageHistoryDeps.cachePath = () => join(root, 'cache.json');
  usageHistoryDeps.now = () => new Date(clock);
  resetUsageHistoryForTests();
  mkdirSync(join(root, 'claude-sessions', 'chat-a', 'projects', 'repo'), { recursive: true });
  mkdirSync(join(root, 'codex', '2026', '09', '23'), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const claudeFile = () => join(root, 'claude-sessions', 'chat-a', 'projects', 'repo', 's.jsonl');

describe('getUsageHistory', () => {
  it("counts Frink's own chats and skips Codex sessions other apps started", async () => {
    writeFileSync(claudeFile(), claudeTurn('m1', 100));
    writeFileSync(
      join(root, 'codex', '2026', '09', '23', 'frink.jsonl'),
      codexRollout('frink', 30),
    );
    writeFileSync(
      join(root, 'codex', '2026', '09', '23', 'desktop.jsonl'),
      codexRollout('Codex Desktop', 999),
    );
    const history = await getUsageHistory();
    expect(history.totalTokens).toBe(130);
    expect(history.conversations).toBe(2);
    expect(history.providers).toEqual({ claude: true, codex: true });
  });

  it('answers from the saved result at once and picks up new usage on the next scan', async () => {
    writeFileSync(claudeFile(), claudeTurn('m1', 100));
    expect((await getUsageHistory()).totalTokens).toBe(100);
    appendFileSync(claudeFile(), claudeTurn('m2', 50));
    clock += 61_000;
    expect((await getUsageHistory()).totalTokens).toBe(100);
    await expect.poll(async () => (await getUsageHistory()).totalTokens).toBe(150);
  });

  it('reloads the saved scan after a restart without losing usage', async () => {
    writeFileSync(claudeFile(), claudeTurn('m1', 100));
    await getUsageHistory();
    resetUsageHistoryForTests();
    expect((await getUsageHistory()).totalTokens).toBe(100);
  });

  it('drops a transcript that was deleted from disk', async () => {
    writeFileSync(claudeFile(), claudeTurn('m1', 100));
    await getUsageHistory();
    rmSync(claudeFile());
    clock += 61_000;
    await getUsageHistory();
    await expect.poll(async () => (await getUsageHistory()).totalTokens).toBe(0);
  });
});

it('makes a call during the first-ever scan wait for the whole history', async () => {
  writeFileSync(claudeFile(), claudeTurn('m1', 100));
  const other = join(root, 'claude-sessions', 'chat-b', 'projects', 'repo');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 's.jsonl'), claudeTurn('m2', 50));
  const [first, second] = await Promise.all([getUsageHistory(), getUsageHistory()]);
  expect([first.totalTokens, second.totalTokens]).toEqual([150, 150]);
});

it('keeps the saved history when a transcript folder cannot be read', async () => {
  writeFileSync(claudeFile(), claudeTurn('m1', 100));
  await getUsageHistory();
  chmodSync(join(root, 'claude-sessions'), 0o000);
  try {
    clock += 61_000;
    await getUsageHistory();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await getUsageHistory()).totalTokens).toBe(100);
  } finally {
    chmodSync(join(root, 'claude-sessions'), 0o755);
  }
});

it('treats only a missing root as empty, not a failed walk under it', async () => {
  expect(await listTranscriptFiles(join(root, 'absent'))).toEqual([]);
  chmodSync(join(root, 'claude-sessions', 'chat-a'), 0o000);
  try {
    expect(await listTranscriptFiles(join(root, 'claude-sessions'))).toBeNull();
  } finally {
    chmodSync(join(root, 'claude-sessions', 'chat-a'), 0o755);
  }
});

describe('readCodexOrigin', () => {
  it('retries a first line still being written instead of judging it not Frink', async () => {
    const path = join(root, 'codex', '2026', '09', '23', 'torn.jsonl');
    writeFileSync(path, codexRollout('frink', 30).slice(0, 25));
    expect(await readCodexOrigin(path)).toBeNull();
    writeFileSync(path, codexRollout('frink', 30));
    expect(await readCodexOrigin(path)).toEqual({ fromFrink: true, subagent: false });
  });
});

it('shares one cache load between concurrent first calls', async () => {
  writeFileSync(claudeFile(), claudeTurn('m1', 100));
  const [a, b] = await Promise.all([getUsageHistory(), getUsageHistory()]);
  expect([a.totalTokens, b.totalTokens]).toEqual([100, 100]);
});

describe('readTranscript', () => {
  it('resumes after appended lines and re-reads a rewritten file from the start', async () => {
    writeFileSync(claudeFile(), claudeTurn('m1', 100));
    const first = await readTranscript(claudeFile(), 'claude');
    appendFileSync(claudeFile(), claudeTurn('m2', 50));
    const resumed = await readTranscript(claudeFile(), 'claude', first?.position);
    expect(resumed).toMatchObject({ resumed: true, records: [{ outputTokens: 50 }] });
    writeFileSync(claudeFile(), claudeTurn('m3', 7) + claudeTurn('m4', 8));
    const rewritten = await readTranscript(claudeFile(), 'claude', resumed?.position);
    expect(rewritten?.resumed).toBe(false);
    expect(rewritten?.records.map((r) => r.outputTokens)).toEqual([7, 8]);
  });

  it('leaves a line the writer has not finished for the next scan', async () => {
    writeFileSync(claudeFile(), claudeTurn('m1', 100) + claudeTurn('m2', 50).slice(0, 40));
    const read = await readTranscript(claudeFile(), 'claude');
    expect(read?.records).toHaveLength(1);
  });
});
