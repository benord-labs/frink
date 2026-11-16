// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trpc } from '@/lib/trpc';
import { mountComponentShot } from './component-shot-harness';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

function HomeAndBase() {
  const home = trpc.external.getHomePath.useQuery();
  const base = trpc.claudeSettings.getWorktreeBasePath.useQuery();
  return (
    <p>
      {home.data ?? 'loading'} {base.isError ? 'base failed' : 'base pending'}
    </p>
  );
}

afterEach(() => {
  document.body.innerHTML = '';
  document.documentElement.className = '';
});

describe('mountComponentShot', () => {
  it('answers from the fixture, lists what it lacks and settles once queries do', async () => {
    const container = document.createElement('div');
    document.body.append(container);

    const state = mountComponentShot(container, HomeAndBase, {
      props: {},
      fixture: { 'external.getHomePath': '/Users/sam' },
      theme: 'dark',
    });

    await state.settled;
    expect(container.querySelector('#shot-root')?.textContent).toBe('/Users/sam base failed');
    expect(state.missing).toEqual(['claudeSettings.getWorktreeBasePath']);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  // component-shot.ts treats a settled page without #shot-root as a crash, not a shot of an empty page.
  it('still settles when the component throws, with the root unmounted', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const Broken = () => {
      throw new Error('render failed');
    };

    const state = mountComponentShot(container, Broken, { props: {}, fixture: {}, theme: 'light' });

    await state.settled;
    expect(container.querySelector('#shot-root')).toBeNull();
    errors.mockRestore();
  });
});
