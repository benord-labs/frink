import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import log from 'electron-log';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as sessionPaths from '../session-plan-paths';
import { recoverSpilledFlowPatchChunk, toolNameInChunks } from './flow-patch-receipt';
import type { UIMessageChunk } from '../types';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spilled-flow-patch-'));
// The real userData has spaces, and macOS tmpdir sits behind the /var -> /private/var symlink.
const userData = path.join(tempRoot, 'Application Support', 'Frink Dev');

const SUB_CHAT = 'subchat-0001';
const OTHER_SUB_CHAT = 'subchat-0002';
const TOOL = 'mcp__frink_dynamic_chat__frink_flows_patch';
const GRAPH = { nodes: [{ id: 'agent-0', blockType: 'agent' }], edges: [] };

const SUCCESS = {
  status: 'success',
  persistence: 'saved',
  flowId: 'flow-1',
  versionId: 'version-7',
  versionNumber: 7,
  name: 'Triage',
  graph: GRAPH,
  flowChange: { added: ['agent-0'] },
  applied: [0],
  failed: [],
  skipped: [],
  message: 'Flow "Triage" patched successfully.',
  templateWarnings: [{ nodeId: 'agent-0', variable: '{{trigger.missing}}' }],
  webhookSetup: [{ nodeId: 'webhook-0', url: 'https://example.test/hook' }],
  sessions: 'Each agent runs in its own session.',
};

const PARTIAL = {
  ...SUCCESS,
  status: 'partial',
  applied: [0],
  failed: [{ index: 1, error: 'Node not found' }],
  skipped: [2],
  retryOps: [1, 2],
};

function toolResultsDir(subChatId: string): string {
  return path.join(
    userData,
    'claude-sessions',
    subChatId,
    'projects',
    '-p',
    'sess',
    'tool-results',
  );
}

function writeSpill(name: string, body: string, subChatId = SUB_CHAT): string {
  const dir = toolResultsDir(subChatId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

function spillNote(file: string): string {
  return `Error: result (87,548 characters) exceeds maximum allowed tokens. Output has been saved to ${file}. Format: JSON with schema: {status: string}`;
}

function outputChunk(file: string): UIMessageChunk {
  return { type: 'tool-output-available', toolCallId: 'call-1', output: spillNote(file) };
}

function recover(chunk: UIMessageChunk, toolName: string | undefined = TOOL): UIMessageChunk {
  return recoverSpilledFlowPatchChunk(chunk, { subChatId: SUB_CHAT, toolName });
}

beforeAll(() => {
  vi.spyOn(log, 'warn').mockImplementation(() => {});
  vi.spyOn(sessionPaths, 'claudeSessionConfigDir').mockImplementation((subChatId) =>
    path.join(userData, 'claude-sessions', subChatId),
  );
  fs.mkdirSync(path.join(userData, 'claude-sessions', SUB_CHAT, 'pasted'), { recursive: true });
});

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('recoverSpilledFlowPatchChunk', () => {
  it('recovers a spilled success receipt with its version-pinned graph', () => {
    const file = writeSpill('success.txt', JSON.stringify(SUCCESS, null, 2));

    expect(recover(outputChunk(file))).toEqual({
      type: 'tool-output-available',
      toolCallId: 'call-1',
      output: {
        status: 'success',
        persistence: 'saved',
        flowId: 'flow-1',
        versionId: 'version-7',
        versionNumber: 7,
        name: 'Triage',
        graph: GRAPH,
        flowChange: { added: ['agent-0'] },
        applied: [0],
        failed: [],
        skipped: [],
        // The card counts these as warnings, exactly as it does for a result that never spilled.
        templateWarnings: SUCCESS.templateWarnings,
        webhookSetup: SUCCESS.webhookSetup,
      },
    });
  });

  it('recovers a spilled partial receipt with its failed and skipped operations', () => {
    const file = writeSpill('partial.txt', JSON.stringify(PARTIAL));

    const recovered = recover(outputChunk(file));

    expect(recovered).toMatchObject({
      type: 'tool-output-available',
      output: { status: 'partial', failed: PARTIAL.failed, skipped: [2], retryOps: [1, 2] },
    });
  });

  it('reads a receipt saved as an MCP text envelope', () => {
    const envelope = [{ type: 'text', text: JSON.stringify(SUCCESS) }];
    const file = writeSpill('envelope.txt', JSON.stringify(envelope));

    expect(recover(outputChunk(file))).toMatchObject({ output: { versionNumber: 7 } });
  });

  it('recovers a note that arrives as an MCP text block', () => {
    const file = writeSpill('block-note.txt', JSON.stringify(SUCCESS));
    const chunk: UIMessageChunk = {
      type: 'tool-output-available',
      toolCallId: 'call-1',
      output: [{ type: 'text', text: spillNote(file) }],
    };

    expect(recover(chunk)).toMatchObject({ output: { status: 'success', versionNumber: 7 } });
  });

  it('keeps the note for a valid receipt above the read cap', () => {
    const padded = `${JSON.stringify(SUCCESS)}${' '.repeat(4 * 1024 * 1024)}`;
    const chunk = outputChunk(writeSpill('oversized.txt', padded));

    expect(recover(chunk)).toBe(chunk);
  });

  it('turns an error-flagged spill into a readable result', () => {
    const file = writeSpill('error-flagged.txt', JSON.stringify(SUCCESS));
    const chunk: UIMessageChunk = {
      type: 'tool-output-error',
      toolCallId: 'call-1',
      errorText: spillNote(file),
    };

    expect(recover(chunk)).toMatchObject({
      type: 'tool-output-available',
      output: { status: 'success' },
    });
  });

  it.each([
    [
      'a truncated file',
      `${JSON.stringify(SUCCESS).slice(0, 80)}\n[exceeded the persist byte limit]`,
    ],
    ['a file that is not JSON', 'not json'],
    ['a failure receipt', JSON.stringify({ status: 'failure', persistence: 'none' })],
    ['a receipt with no flow id', JSON.stringify({ ...SUCCESS, flowId: undefined })],
  ])('keeps the note for %s', (_label, body) => {
    const chunk = outputChunk(writeSpill(`${_label.replaceAll(' ', '-')}.txt`, body));

    expect(recover(chunk)).toBe(chunk);
  });

  it('keeps the note when the saved file is missing', () => {
    const chunk = outputChunk(path.join(toolResultsDir(SUB_CHAT), 'missing.txt'));

    expect(recover(chunk)).toBe(chunk);
  });

  it.each([
    ['another chat', () => writeSpill('other.txt', JSON.stringify(SUCCESS), OTHER_SUB_CHAT)],
    [
      'the pasted folder',
      () => {
        const file = path.join(userData, 'claude-sessions', SUB_CHAT, 'pasted', 'paste.txt');
        fs.writeFileSync(file, JSON.stringify(SUCCESS));
        return file;
      },
    ],
    [
      'outside the session folder',
      () => {
        const file = path.join(userData, 'outside.txt');
        fs.writeFileSync(file, JSON.stringify(SUCCESS));
        return file;
      },
    ],
    [
      'a symlink inside tool-results',
      () => {
        const target = path.join(userData, 'target.txt');
        fs.writeFileSync(target, JSON.stringify(SUCCESS));
        const link = path.join(toolResultsDir(SUB_CHAT), 'link.txt');
        fs.symlinkSync(target, link);
        return link;
      },
    ],
  ])('refuses a file in %s', (_label, makeFile) => {
    const chunk = outputChunk(makeFile());

    expect(recover(chunk)).toBe(chunk);
  });

  it('leaves other tools alone', () => {
    const chunk = outputChunk(writeSpill('other-tool.txt', JSON.stringify(SUCCESS)));

    expect(recover(chunk, 'mcp__frink_dynamic_chat__frink_flows_get')).toBe(chunk);
    expect(recover(chunk, 'mcp__someone_else__frink_flows_patch')).toBe(chunk);
    expect(recoverSpilledFlowPatchChunk(chunk, { subChatId: SUB_CHAT, toolName: undefined })).toBe(
      chunk,
    );
  });

  it('leaves a normal receipt alone', () => {
    const chunk: UIMessageChunk = {
      type: 'tool-output-available',
      toolCallId: 'call-1',
      output: SUCCESS,
    };

    expect(recover(chunk)).toBe(chunk);
  });
});

describe('toolNameInChunks', () => {
  it('finds the tool name from the call input chunks', () => {
    const chunks: UIMessageChunk[] = [
      { type: 'tool-input-start', toolCallId: 'call-1', toolName: TOOL },
      { type: 'tool-input-available', toolCallId: 'call-2', toolName: 'Read', input: {} },
    ];

    expect(toolNameInChunks(chunks, 'call-1')).toBe(TOOL);
    expect(toolNameInChunks(chunks, 'call-3')).toBeUndefined();
  });
});
