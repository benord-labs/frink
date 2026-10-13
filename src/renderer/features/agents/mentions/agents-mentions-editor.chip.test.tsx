// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mentionChipClass } from '@/lib/mentions/mention-chip-class';
import { AgentsMentionsEditor, type AgentsMentionsEditorHandle } from './agents-mentions-editor';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

afterEach(cleanup);

function renderWithMention() {
  const ref = createRef<AgentsMentionsEditorHandle>();
  const { container } = render(
    <AgentsMentionsEditor ref={ref} onTrigger={vi.fn()} onCloseTrigger={vi.fn()} />,
  );
  ref.current?.setValue('see @[file:local:src/a.ts] now');
  const editor = container.querySelector<HTMLElement>('[contenteditable="true"]');
  const chip = container.querySelector<HTMLElement>('[data-mention-id]');
  if (!editor || !chip) throw new Error('The editor did not draw the mention');
  return { editor, chip };
}

describe('composer mention chip', () => {
  it('draws the mention with the shared chip look and its full path on hover', async () => {
    const { chip } = renderWithMention();

    await waitFor(() => expect(chip.className).toBe(mentionChipClass()));
    expect(chip).toHaveTextContent('a.ts');
    expect(chip).toHaveAttribute('title', 'src/a.ts');
    expect(chip.querySelector('svg')).not.toBeNull();
  });

  it('takes the selected look while a selection covers it and drops it when cleared', async () => {
    const { editor, chip } = renderWithMention();
    await waitFor(() => expect(chip.className).toBe(mentionChipClass()));

    window.getSelection()?.selectAllChildren(editor);
    await waitFor(() => expect(chip.className).toBe(mentionChipClass({ selected: true })));

    window.getSelection()?.removeAllRanges();
    await waitFor(() => expect(chip.className).toBe(mentionChipClass()));
  });
});
