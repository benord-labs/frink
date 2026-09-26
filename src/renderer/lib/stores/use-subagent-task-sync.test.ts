/**
 * The subagent-task IPC boundary. `socket:subagent-task-changed` arrives as `unknown`, and a
 * malformed frame must leave the running set untouched — a garbage key written here would either
 * animate a card forever or never retire one.
 */
import { describe, expect, it } from 'vitest';
import { isSubagentTaskPayload } from './use-subagent-task-sync';

describe('isSubagentTaskPayload', () => {
  it('accepts a well-formed start and retraction', () => {
    expect(isSubagentTaskPayload({ subChatId: 'sc1', toolCallId: 'tu1', running: true })).toBe(
      true,
    );
    expect(isSubagentTaskPayload({ subChatId: 'sc1', toolCallId: 'tu1', running: false })).toBe(
      true,
    );
  });

  it('rejects a missing or empty toolCallId — there is no card it could address', () => {
    expect(isSubagentTaskPayload({ subChatId: 'sc1', running: true })).toBe(false);
    expect(isSubagentTaskPayload({ subChatId: 'sc1', toolCallId: '', running: true })).toBe(false);
    expect(isSubagentTaskPayload({ subChatId: 'sc1', toolCallId: 7, running: true })).toBe(false);
  });

  it('rejects a missing or wrongly-typed subChatId or running flag', () => {
    expect(isSubagentTaskPayload({ toolCallId: 'tu1', running: true })).toBe(false);
    expect(isSubagentTaskPayload({ subChatId: 1, toolCallId: 'tu1', running: true })).toBe(false);
    expect(isSubagentTaskPayload({ subChatId: 'sc1', toolCallId: 'tu1', running: 'yes' })).toBe(
      false,
    );
  });

  it('rejects a non-object frame', () => {
    expect(isSubagentTaskPayload(null)).toBe(false);
    expect(isSubagentTaskPayload(undefined)).toBe(false);
    expect(isSubagentTaskPayload('running')).toBe(false);
  });
});
