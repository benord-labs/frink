// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Operation } from '@trpc/client';
import { createStore, Provider } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithTrpc } from '@/lib/test-utils/render-with-trpc';
import { buildTriggerSummary } from '../../../../../shared/lib/trigger-summary';
import type { TriggerContext } from '../../../../../shared/types/trigger-context';
import { TooltipProvider } from '../../../../components/ui/tooltip';
import { MemoizedTextPart } from '../../main/memoized-text-part';
import { SearchHighlightProvider } from '../../search';
import {
  chatSearchCurrentIndexAtom,
  chatSearchMatchesAtom,
  chatSearchOpenAtom,
  chatSearchQueryAtom,
} from '../../search/chat-search-atoms';
import { extractSearchableText, findMatches } from '../../search/chat-search-utils';
import { TriggerBubble } from '../../ui/trigger-bubble';
import { FileLinkBadge, FileLinkBadgeProvider } from '.';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

afterEach(cleanup);

async function refuseOperation(op: Operation): Promise<never> {
  throw new Error(`Unexpected test operation: ${op.path}`);
}

/** The visible badge showing `name`, not the hidden text it stands in for. */
function badgeNamed(name: string, scope: Pick<typeof screen, 'getByText'> = screen): HTMLElement {
  const badge = scope.getByText(name, { ignore: '[aria-hidden]' }).parentElement;
  if (!badge) throw new Error(`No badge around ${name}`);
  return badge;
}

describe('FileLinkBadge', () => {
  it('shows the file name and line, with the path as it was written as its tooltip', () => {
    render(
      <TooltipProvider>
        <FileLinkBadge reference={{ path: './src/./a.ts', line: 12, label: './src/./a.ts' }} />
      </TooltipProvider>,
    );

    const badge = badgeNamed('a.ts');
    expect(screen.getByText('a.ts').nextElementSibling).toHaveTextContent('L12');
    expect(badge.querySelector('svg')).not.toBeNull();
    fireEvent.focus(badge);
    expect(screen.getByRole('tooltip')).toHaveTextContent(/^src\/a\.ts$/);
  });

  it('shows a home path as written and no line when none is given', () => {
    render(
      <TooltipProvider>
        <FileLinkBadge reference={{ path: '~/notes/a.md', label: '~/notes/a.md' }} />
      </TooltipProvider>,
    );

    expect(screen.getByText('a.md').nextElementSibling).toBeNull();
    fireEvent.focus(badgeNamed('a.md'));
    expect(screen.getByRole('tooltip')).toHaveTextContent(/^~\/notes\/a\.md$/);
  });

  it("keeps a link's own words and shows the badge after them", () => {
    const { container } = render(
      <TooltipProvider>
        <FileLinkBadge reference={{ path: '/Users/x/handler.ts', label: 'the handler' }} />
      </TooltipProvider>,
    );

    expect(container).toHaveTextContent(/^the handler handler\.ts$/);
    expect(container.firstChild).toHaveTextContent('the handler');
  });

  it('is a focusable badge, not a link or a button', () => {
    render(
      <TooltipProvider>
        <FileLinkBadge reference={{ path: '/Users/x/a.ts', label: 'a.ts' }} />
      </TooltipProvider>,
    );

    expect(badgeNamed('a.ts')).toHaveAttribute('tabindex', '0');
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('file badges in a chat transcript', () => {
  const reply = 'Fixed `src/a.ts:42` and [notes](~/notes/a.md).';
  const trigger: TriggerContext = {
    source: 'shortcut',
    sourceAccountId: 'acc',
    eventType: 'story_update',
    triggeredBy: { name: 'Tester' },
    timestamp: '2026-03-03T10:00:00.000Z',
    fullContent: { actions: [{ entity_type: 'story', name: 'Fix it', description: reply }] },
  };

  it('draws badges in an assistant reply but not in a trigger dialog opened beside it', () => {
    renderWithTrpc(
      <TooltipProvider>
        <FileLinkBadgeProvider>
          <section aria-label="Transcript">
            <MemoizedTextPart
              text={reply}
              messageId="m1"
              partIndex={0}
              isFinalText
              visibleStepsCount={1}
              renderMarkdown
            />
          </section>
          <TriggerBubble data={buildTriggerSummary(trigger)} triggerContext={trigger} />
        </FileLinkBadgeProvider>
      </TooltipProvider>,
      refuseOperation,
    );

    const transcript = within(screen.getByRole('region', { name: 'Transcript' }));
    const tooltip = () => screen.getByRole('tooltip');
    expect(transcript.getByText('a.ts').nextElementSibling).toHaveTextContent('L42');
    fireEvent.focus(badgeNamed('a.ts', transcript));
    expect(tooltip()).toHaveTextContent(/^src\/a\.ts$/);
    fireEvent.blur(badgeNamed('a.ts', transcript));
    fireEvent.focus(badgeNamed('a.md', transcript));
    expect(tooltip()).toHaveTextContent(/^~\/notes\/a\.md$/);
    expect(transcript.getByText(/and notes/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { expanded: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Open content' }));
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText('src/a.ts:42')).not.toHaveAttribute('aria-hidden');
    expect(dialog.queryByText('a.ts')).toBeNull();
    expect(dialog.queryByText('a.md')).toBeNull();
  });

  // Chat search counts matches in the reply's text, then highlights the page by match position.
  it.each(['renderer', 'x.tsx', 'components/x.tsx:42', '42'])(
    'keeps chat search for %j in step with the badges',
    (query) => {
      const text =
        'Changed `src/renderer/components/x.tsx:42` and `src/renderer/y.ts`; the renderer and x.tsx are fine at 42.';
      const matches = findMatches(
        extractSearchableText([{ id: 'm1', role: 'assistant', parts: [{ type: 'text', text }] }]),
        query,
      );
      expect(matches.length).toBeGreaterThan(0);

      matches.forEach((_match, current) => {
        const store = createStore();
        store.set(chatSearchOpenAtom, true);
        store.set(chatSearchQueryAtom, query);
        store.set(chatSearchMatchesAtom, matches);
        store.set(chatSearchCurrentIndexAtom, current);
        const { container, unmount } = renderWithTrpc(
          <Provider store={store}>
            <TooltipProvider>
              <SearchHighlightProvider>
                <FileLinkBadgeProvider>
                  <MemoizedTextPart
                    text={text}
                    messageId="m1"
                    partIndex={0}
                    isFinalText
                    visibleStepsCount={0}
                    renderMarkdown
                  />
                </FileLinkBadgeProvider>
              </SearchHighlightProvider>
            </TooltipProvider>
          </Provider>,
          refuseOperation,
        );

        const marks = Array.from(container.querySelectorAll('mark'));
        expect(marks).toHaveLength(matches.length);
        expect(marks.findIndex((mark) => mark.matches('.search-highlight-current'))).toBe(current);
        unmount();
      });
    },
  );
});
