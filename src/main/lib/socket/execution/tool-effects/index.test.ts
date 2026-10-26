import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { JsonValue } from '../../../../../shared/types/permissions';
import type { UIMessageChunk } from '../../../claude/types';
import { createToolEffects } from '.';

const CWD = path.resolve('/wt/root');
const SUB_CHAT = 'sub-1';
const NOTES = path.resolve(CWD, 'notes.md');

const card = (toolCallId: string, toolName: string, input: JsonValue): UIMessageChunk => ({
  type: 'tool-input-available',
  toolCallId,
  toolName,
  input,
});
const done = (toolCallId: string): UIMessageChunk => ({
  type: 'tool-output-available',
  toolCallId,
  output: 'ok',
});
const failed = (toolCallId: string): UIMessageChunk => ({
  type: 'tool-output-error',
  toolCallId,
  errorText: 'denied',
});

/** Feeds `chunks` to one stream's effects and returns what it told the renderer. */
function play(chunks: UIMessageChunk[]) {
  const notify = vi.fn();
  const effects = createToolEffects(CWD, SUB_CHAT, notify);
  for (const chunk of chunks) effects(chunk);
  return notify;
}

describe('createToolEffects', () => {
  it.each([
    ['Write', { file_path: NOTES }],
    ['Edit', { file_path: NOTES }],
    ['MultiEdit', { file_path: NOTES }],
    ['NotebookEdit', { notebook_path: NOTES }],
    ['Delete', { file_path: NOTES }],
  ])('a finished %s card tells the renderer its file changed', (toolName, input) => {
    const notify = play([card('c1', toolName, input), done('c1')]);
    expect(notify.mock.calls).toEqual([
      [{ filePath: NOTES, type: `tool-${toolName}`, subChatId: SUB_CHAT }],
    ]);
  });

  it('resolves a relative path against the chat folder and keeps an absolute one', () => {
    const elsewhere = path.resolve('/elsewhere', 'a.md');
    const notify = play([
      card('rel', 'Write', { file_path: 'notes.md' }),
      done('rel'),
      card('abs', 'Write', { file_path: elsewhere }),
      done('abs'),
    ]);
    expect(notify.mock.calls.map(([change]) => change.filePath)).toEqual([NOTES, elsewhere]);
  });

  it.each([
    ['a read', 'Read', { file_path: NOTES }],
    ['a shell command', 'Bash', { command: 'touch notes.md' }],
    ['a Codex edit naming its files in changes', 'Edit', { changes: [{ path: NOTES }] }],
    ['the legacy file key', 'Write', { file: NOTES }],
    ['a non-string path', 'Write', { file_path: 99 }],
    ['an empty path', 'Write', { file_path: '' }],
  ])('stays silent for %s', (_case, toolName, input) => {
    expect(play([card('c1', toolName, input), done('c1')])).not.toHaveBeenCalled();
  });

  it('waits for the output, and ignores an output with no card', () => {
    expect(play([card('c1', 'Write', { file_path: NOTES })])).not.toHaveBeenCalled();
    expect(play([done('c1')])).not.toHaveBeenCalled();
  });

  it('forgets a write that failed or was denied', () => {
    const notify = play([card('c1', 'Write', { file_path: NOTES }), failed('c1'), done('c1')]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('takes the latest card for a call id', () => {
    const resent = play([
      card('c1', 'Write', {}),
      card('c1', 'Write', { file_path: NOTES }),
      done('c1'),
    ]);
    expect(resent.mock.calls).toEqual([[expect.objectContaining({ filePath: NOTES })]]);

    const replaced = play([
      card('c1', 'Write', { file_path: NOTES }),
      card('c1', 'Read', { file_path: NOTES }),
      done('c1'),
    ]);
    expect(replaced).not.toHaveBeenCalled();
  });

  it('reports each card of a split patch', () => {
    const other = path.resolve(CWD, 'other.md');
    const notify = play([
      card('call', 'Edit', { file_path: NOTES }),
      card('call#1', 'Edit', { file_path: other }),
      done('call'),
      done('call#1'),
    ]);
    expect(notify.mock.calls.map(([change]) => change.filePath)).toEqual([NOTES, other]);
  });

  it('reports a finished call once, even when its output repeats', () => {
    const notify = play([card('c1', 'Write', { file_path: NOTES }), done('c1'), done('c1')]);
    expect(notify).toHaveBeenCalledOnce();
  });
});
