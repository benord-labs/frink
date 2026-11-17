// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  SYMLINK_ESCAPE_RECHECK_MS,
  type UseSymlinkEscapeQuery,
  useSymlinkEscape,
} from './use-symlink-escape';

type Call = Parameters<UseSymlinkEscapeQuery>;

let answers: Record<string, { escapes: false } | { escapes: true; realPath: string }>;
let lastCall: Call | undefined;

const useEscapeQuery: UseSymlinkEscapeQuery = (input, options) => {
  lastCall = [input, options];
  return {
    data: options.enabled ? answers[`${input.projectPath}|${input.filePath}`] : undefined,
  };
};

beforeEach(() => {
  answers = {};
  lastCall = undefined;
});

describe('useSymlinkEscape', () => {
  it('returns where the file really lives when it leaves the project', () => {
    answers['/repo|/repo/config.yml'] = { escapes: true, realPath: '/Users/me/.bashrc' };

    const { result } = renderHook(() =>
      useSymlinkEscape(useEscapeQuery, '/repo', '/repo/config.yml'),
    );

    expect(result.current).toBe('/Users/me/.bashrc');
    expect(lastCall?.[0]).toEqual({ projectPath: '/repo', filePath: '/repo/config.yml' });
  });

  it('returns nothing for a file that stays inside the project', () => {
    answers['/repo|/repo/src/a.ts'] = { escapes: false };

    const { result } = renderHook(() =>
      useSymlinkEscape(useEscapeQuery, '/repo', '/repo/src/a.ts'),
    );

    expect(result.current).toBeNull();
  });

  // No event covers every way a link can be swapped in (agent, terminal, another editor),
  // so the visible tab re-checks on a timer and whenever the window regains focus.
  it('keeps re-checking the open file while it is shown', () => {
    renderHook(() => useSymlinkEscape(useEscapeQuery, '/repo', '/repo/config.yml'));

    expect(lastCall?.[1]).toMatchObject({
      enabled: true,
      refetchInterval: SYMLINK_ESCAPE_RECHECK_MS,
      refetchOnWindowFocus: 'always',
    });
  });

  it('does not ask or poll when there is no project or no open file', () => {
    const withoutProject = renderHook(() =>
      useSymlinkEscape(useEscapeQuery, undefined, '/tmp/plan.md'),
    );
    expect(withoutProject.result.current).toBeNull();
    expect(lastCall?.[1]).toMatchObject({ enabled: false, refetchInterval: false });

    const withoutFile = renderHook(() => useSymlinkEscape(useEscapeQuery, '/repo', null));
    expect(withoutFile.result.current).toBeNull();
    expect(lastCall?.[1]).toMatchObject({ enabled: false, refetchInterval: false });
  });

  // Split view: the same relative file in two projects must not borrow each other's answer.
  it('answers for the tab now showing after a switch to another project', () => {
    answers['/repo-a|/repo-a/config.yml'] = { escapes: true, realPath: '/Users/me/.bashrc' };
    answers['/repo-b|/repo-b/config.yml'] = { escapes: false };

    const { result, rerender } = renderHook(
      ({ project }: { project: string }) =>
        useSymlinkEscape(useEscapeQuery, project, `${project}/config.yml`),
      { initialProps: { project: '/repo-a' } },
    );
    expect(result.current).toBe('/Users/me/.bashrc');

    rerender({ project: '/repo-b' });

    expect(result.current).toBeNull();
  });
});
