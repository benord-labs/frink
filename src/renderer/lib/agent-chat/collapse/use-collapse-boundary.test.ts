// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useCollapseBoundary } from './use-collapse-boundary';

type Part = { type?: string; text?: string; toolCallId?: string };

const tool = (): Part => ({ type: 'tool-Bash' });
const text = (t = 'answer'): Part => ({ type: 'text', text: t });
const isHoisted = (p: Part) => p.type === 'tool-AskUserQuestion';

function mount(initial: {
  messageId?: string;
  parts: Part[];
  stableIsStreaming?: boolean;
  isLastMessage?: boolean;
}) {
  return renderHook((props) => useCollapseBoundary({ ...props, isHoisted }), {
    initialProps: {
      messageId: initial.messageId ?? 'm1',
      parts: initial.parts,
      stableIsStreaming: initial.stableIsStreaming ?? false,
      isLastMessage: initial.isLastMessage ?? true,
      isHoisted,
    },
  });
}

describe('useCollapseBoundary', () => {
  it('collapses at the trailing text once the turn settled', () => {
    const { result } = mount({ parts: [tool(), text()] });
    expect(result.current).toMatchObject({ shouldCollapse: true, collapseBeforeIndex: 1 });
  });

  it('does not collapse while the last message still streams', () => {
    const { result } = mount({ parts: [tool(), text()], stableIsStreaming: true });
    expect(result.current.shouldCollapse).toBe(false);
  });

  it('does not collapse a message that never produced text after tools', () => {
    const { result } = mount({ parts: [text('intro'), tool()] });
    expect(result.current.shouldCollapse).toBe(false);
  });

  it('latches the boundary when a wake burst appends a tool part after settled text', () => {
    const settled = [tool(), text()];
    const { result, rerender } = mount({ parts: settled });
    expect(result.current.collapseBeforeIndex).toBe(1);

    // Next burst opens with a tool part — the text-after-tools anchor flips false, but the
    // committed boundary must not regress (no re-expand + scroll jump per wake).
    rerender({
      messageId: 'm1',
      parts: [...settled, tool()],
      stableIsStreaming: true,
      isLastMessage: true,
      isHoisted,
    });
    expect(result.current).toMatchObject({ shouldCollapse: true, collapseBeforeIndex: 1 });
  });

  it('starts fresh for a different message id', () => {
    const { result, rerender } = mount({ parts: [tool(), text()] });
    expect(result.current.shouldCollapse).toBe(true);

    rerender({
      messageId: 'm2',
      parts: [tool()],
      stableIsStreaming: true,
      isLastMessage: true,
      isHoisted,
    });
    expect(result.current.shouldCollapse).toBe(false);
  });

  it('anchors on the ROOT’s answer, never on a subagent’s prose', () => {
    // Subagent prose is a tool part (it carries a composite id), so it cannot pose as the turn's
    // final answer the way a plain text part would — the root's own reply stays the anchor.
    const prose: Part = { type: 'tool-SubagentText', toolCallId: 'task-a:say' };
    const { result } = mount({ parts: [tool(), text('the answer'), prose] });
    expect(result.current.collapseBeforeIndex).toBe(1);
  });

  it('splits the collapsed region into hidden steps and hoisted entries', () => {
    const ask: Part = { type: 'tool-AskUserQuestion' };
    const { result } = mount({ parts: [tool(), ask, tool(), text()] });
    expect(result.current.collapseBeforeIndex).toBe(3);
    expect(result.current.hoistedEntries).toEqual([{ index: 1, part: ask }]);
    expect(result.current.collapsedStepParts).toEqual([tool(), tool()]);
  });
});
