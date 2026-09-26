import { describe, expect, it } from 'vitest';
import { getRuntimeBaseTools } from './dynamic-chat-tool-catalog';

function hasTaskSignal(taskSignalEnabled: boolean): boolean {
  return getRuntimeBaseTools(taskSignalEnabled).some((tool) => tool.name === 'frink_task_signal');
}

describe('getRuntimeBaseTools', () => {
  it('offers frink_task_signal only while a live task expects a lifecycle signal', () => {
    expect(hasTaskSignal(true)).toBe(true);
    expect(hasTaskSignal(false)).toBe(false);
  });
});
