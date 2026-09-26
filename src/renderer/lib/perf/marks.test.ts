import { afterEach, describe, expect, it, vi } from 'vitest';
import { perfMark } from './marks';

describe('perfMark', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('stamps a DevTools marker whose properties are string pairs', () => {
    const mark = vi.spyOn(performance, 'mark');
    perfMark('chat:open', { chatId: 'c1', panes: 4, streaming: false, note: undefined });
    expect(mark).toHaveBeenCalledWith('chat:open', {
      detail: {
        devtools: {
          dataType: 'marker',
          properties: [
            ['chatId', 'c1'],
            ['panes', '4'],
            ['streaming', 'false'],
            ['note', ''],
          ],
        },
      },
    });
  });

  it('is inert outside dev builds', () => {
    vi.stubEnv('DEV', false);
    const mark = vi.spyOn(performance, 'mark');
    perfMark('chat:open', { chatId: 'c1' });
    expect(mark).not.toHaveBeenCalled();
  });
});
