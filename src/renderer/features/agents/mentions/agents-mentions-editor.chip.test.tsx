// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { createRef, useEffect, useRef } from 'react';
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

// Restores a value from an effect, the way draft restore does, so the chips are built mid-commit.
function EffectRestoredEditor({ value }: { value: string }) {
  const ref = useRef<AgentsMentionsEditorHandle>(null);
  useEffect(() => {
    ref.current?.setValue(value);
  }, [value]);
  return <AgentsMentionsEditor ref={ref} onTrigger={vi.fn()} onCloseTrigger={vi.fn()} />;
}

function iconsRestoredInEffect(value: string): SVGSVGElement[] {
  const { container } = render(<EffectRestoredEditor value={value} />);
  return [...container.querySelectorAll<SVGSVGElement>('[data-mention-id] svg')];
}

describe('composer mention chip restored inside an effect', () => {
  it('draws the file-type icon, not a generic glyph', () => {
    const [icon] = iconsRestoredInEffect('see @[file:local:src/a.ts]');
    expect(icon).toHaveAttribute('viewBox', '0 0 32 32');
  });

  it('draws the skill icon', () => {
    const [icon] = iconsRestoredInEffect('use @[skill:review]');
    expect(icon).toHaveClass('lucide-tool-case');
  });

  // Each mention type routes to its own icon; a miswired type would draw a neighbour's glyph.
  it.each([
    ['folder', '@[folder:local:src/lib]', 'lucide-folder-open'],
    ['agent', '@[agent:reviewer]', 'lucide-bot'],
    ['briefing', '@[briefing:flow1:QQ==:QQ==]', 'lucide-file-text'],
    ['unknown file type', '@[file:local:LICENSE]', 'lucide-files'],
  ])('draws the %s icon', (_kind, token, iconClass) => {
    const [icon] = iconsRestoredInEffect(token);
    expect(icon).toHaveClass(iconClass);
  });

  it('draws the MCP logo for a tool', () => {
    const [icon] = iconsRestoredInEffect('@[tool:mcp__figma__get_design]');
    expect(icon).not.toHaveClass('lucide');
    expect(icon).toHaveAttribute('viewBox', '0 0 24 24');
    expect(icon.querySelector('path')).not.toBeNull();
  });

  it('gives each chip its own gradient ids', () => {
    const icons = iconsRestoredInEffect('@[file:local:a.py] and @[file:local:b.py]');
    const ids = icons.map((icon) => [...icon.querySelectorAll('[id]')].map((el) => el.id));
    expect(ids[0].length).toBeGreaterThan(0);
    expect(ids[0].filter((id) => ids[1].includes(id))).toEqual([]);
  });
});

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
