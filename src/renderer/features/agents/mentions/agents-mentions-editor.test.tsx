// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock trpc (used by agents-file-mention transitive dep)
vi.mock('../../../lib/trpc', () => ({
  trpc: {},
}));

import { AgentsMentionsEditor, type AgentsMentionsEditorHandle } from './agents-mentions-editor';

afterEach(() => {
  cleanup();
});

function renderEditor({
  onSlashTrigger = vi.fn(),
  onCloseSlashTrigger = vi.fn(),
}: {
  onSlashTrigger?: (payload: { searchText: string; rect: DOMRect }) => void;
  onCloseSlashTrigger?: () => void;
} = {}) {
  const ref = createRef<AgentsMentionsEditorHandle>();
  const result = render(
    <AgentsMentionsEditor
      ref={ref}
      onTrigger={vi.fn()}
      onCloseTrigger={vi.fn()}
      onSlashTrigger={onSlashTrigger}
      onCloseSlashTrigger={onCloseSlashTrigger}
    />,
  );
  return { ref, onSlashTrigger, onCloseSlashTrigger, ...result };
}

/** Helper to get all command highlight spans */
function getCommandHighlights(container: HTMLElement): HTMLSpanElement[] {
  return Array.from(container.querySelectorAll('[data-command-highlight]'));
}

/** Helper to get the contenteditable root */
function getEditorRoot(container: HTMLElement): HTMLElement {
  return container.querySelector('[contenteditable="true"]') as HTMLElement;
}

/** Helper to simulate cursor at a specific position in the editor */
function setCursorAtEnd(root: HTMLElement): void {
  const range = document.createRange();
  const sel = window.getSelection();
  if (!sel) return;

  // Position cursor at end of content
  if (root.lastChild) {
    if (root.lastChild.nodeType === Node.TEXT_NODE) {
      range.setStart(root.lastChild, root.lastChild.textContent?.length ?? 0);
    } else {
      range.setStartAfter(root.lastChild);
    }
  } else {
    range.setStart(root, 0);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Helper to simulate cursor at a specific offset in a text node */
function setCursorInTextNode(root: HTMLElement, textNodeIndex: number, offset: number): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Text | null = null;
  let idx = 0;
  while (walker.nextNode()) {
    if (idx === textNodeIndex) {
      node = walker.currentNode as Text;
      break;
    }
    idx++;
  }
  if (!node) return;

  const range = document.createRange();
  const sel = window.getSelection();
  if (!sel) return;
  range.setStart(node, offset);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function waitForRaf(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

describe('AgentsMentionsEditor.setCommandValue', () => {
  describe('multiple commands (main bug fix)', () => {
    it('preserves first command when inserting second command', () => {
      const { ref, container } = renderEditor();
      const root = getEditorRoot(container);
      root.focus();

      // Insert first command
      setCursorAtEnd(root);
      ref.current?.setCommandValue('edge-cases', 'First command content');

      // Verify first command exists
      let highlights = getCommandHighlights(container);
      expect(highlights).toHaveLength(1);
      expect(highlights[0].getAttribute('data-command-highlight')).toBe('edge-cases');

      // Move cursor to end and insert second command
      setCursorAtEnd(root);
      ref.current?.setCommandValue('build-tests', 'Second command content');

      // Both commands should exist
      highlights = getCommandHighlights(container);
      expect(highlights).toHaveLength(2);
      expect(highlights[0].getAttribute('data-command-highlight')).toBe('edge-cases');
      expect(highlights[1].getAttribute('data-command-highlight')).toBe('build-tests');
    });

    it('preserves text content when inserting multiple commands', () => {
      const { ref, container } = renderEditor();
      const root = getEditorRoot(container);
      root.focus();

      // Set initial text
      ref.current?.setValue('Hello world');

      // Insert command at end
      setCursorAtEnd(root);
      ref.current?.setCommandValue('cmd1', 'Content 1');

      // Add more text after (simulate user typing)
      const textNode = document.createTextNode('\nMore text');
      root.appendChild(textNode);

      // Insert another command at end
      setCursorAtEnd(root);
      ref.current?.setCommandValue('cmd2', 'Content 2');

      // Verify all content preserved
      const serialized = ref.current?.getValue() ?? '';
      expect(serialized).toContain('Hello world');
      expect(serialized).toContain('[/cmd:cmd1]');
      expect(serialized).toContain('[/cmd:cmd2]');
      expect(serialized).toContain('More text');
    });
  });

  describe('preserves existing content', () => {
    it('preserves text before cursor position', () => {
      const { ref, container } = renderEditor();
      const root = getEditorRoot(container);
      root.focus();

      // Set initial text
      ref.current?.setValue('Prefix text ');

      // Cursor at end
      setCursorAtEnd(root);
      ref.current?.setCommandValue('test', 'Command content');

      // Serialized output should have prefix
      const serialized = ref.current?.getValue() ?? '';
      expect(serialized).toContain('Prefix text');
      expect(serialized).toContain('[/cmd:test]');
    });

    it('preserves text after cursor position when cursor is mid-content', () => {
      const { ref, container } = renderEditor();
      const root = getEditorRoot(container);
      root.focus();

      // Set text with space in middle for cursor placement
      ref.current?.setValue('Before  After');

      // Position cursor at the space (offset 7, after "Before ")
      setCursorInTextNode(root, 0, 7);
      ref.current?.setCommandValue('middle', 'Inserted');

      // Both before and after text should be preserved
      const serialized = ref.current?.getValue() ?? '';
      expect(serialized).toContain('Before');
      expect(serialized).toContain('After');
      expect(serialized).toContain('[/cmd:middle]');
    });
  });

  describe('empty editor', () => {
    it('inserts command into empty editor', () => {
      const { ref, container } = renderEditor();
      const root = getEditorRoot(container);
      root.focus();

      // Ensure editor is empty
      expect(root.textContent).toBe('');

      // Insert command
      setCursorAtEnd(root);
      ref.current?.setCommandValue('first', 'First command');

      // Command should be inserted
      const highlights = getCommandHighlights(container);
      expect(highlights).toHaveLength(1);
      expect(highlights[0].textContent).toBe('First command');
    });

    it('places cursor after inserted command', () => {
      const { ref, container } = renderEditor();
      const root = getEditorRoot(container);
      root.focus();

      setCursorAtEnd(root);
      ref.current?.setCommandValue('cmd', 'Content');

      // Cursor should be positioned after the command (in trailing newline)
      const sel = window.getSelection();
      expect(sel?.rangeCount).toBeGreaterThan(0);

      // The cursor should be in a text node (the trailing newline)
      const range = sel?.getRangeAt(0);
      expect(range?.startContainer.nodeType).toBe(Node.TEXT_NODE);
    });

    it('adds newline after command so next slash command can be typed immediately', () => {
      const { ref, container } = renderEditor();
      const root = getEditorRoot(container);
      root.focus();

      setCursorAtEnd(root);
      ref.current?.setCommandValue('cmd1', 'First');

      // After first command, cursor should be at start of new line
      // Verify the trailing text is a newline + zero-width space (ZWS prevents browser quirks)
      const sel = window.getSelection();
      const range = sel?.getRangeAt(0);
      expect(range?.startContainer.textContent).toBe('\n\u200B');
      expect(range?.startOffset).toBe(2); // After the newline and zero-width space

      // This means typing / now will be at line start (after \n\u200B)
      // Simulate typing second command without manually adding newline
      ref.current?.setCommandValue('cmd2', 'Second');

      // Both commands should exist
      const highlights = getCommandHighlights(container);
      expect(highlights).toHaveLength(2);
    });
  });

  describe('adjacent to command block', () => {
    it('inserts command after existing command block', () => {
      const { ref, container } = renderEditor();
      const root = getEditorRoot(container);
      root.focus();

      // Insert first command
      setCursorAtEnd(root);
      ref.current?.setCommandValue('first', 'First');

      // Insert second command (newline is already added automatically)
      setCursorAtEnd(root);
      ref.current?.setCommandValue('second', 'Second');

      // Both should exist
      const highlights = getCommandHighlights(container);
      expect(highlights).toHaveLength(2);

      // Serialization should work correctly
      const serialized = ref.current?.getValue() ?? '';
      expect(serialized).toContain('[/cmd:first]');
      expect(serialized).toContain('[/cmd:second]');
    });
  });

  describe('getValue serialization', () => {
    it('serializes multiple commands correctly', () => {
      const { ref, container } = renderEditor();
      const root = getEditorRoot(container);
      root.focus();

      // Insert two commands with text between
      setCursorAtEnd(root);
      ref.current?.setCommandValue('cmd1', 'Content one');

      root.appendChild(document.createTextNode(' some text '));

      setCursorAtEnd(root);
      ref.current?.setCommandValue('cmd2', 'Content two');

      const serialized = ref.current?.getValue() ?? '';

      // Verify format: [/cmd:name]\ncontent\n[/cmd-end]
      expect(serialized).toMatch(/\[\/cmd:cmd1\]\nContent one\n\[\/cmd-end\]/);
      expect(serialized).toMatch(/\[\/cmd:cmd2\]\nContent two\n\[\/cmd-end\]/);
      expect(serialized).toContain('some text');
    });

    it('does not leak zero-width typing anchors into serialized output', () => {
      const { ref, container } = renderEditor();
      const root = getEditorRoot(container);
      root.focus();

      setCursorAtEnd(root);
      ref.current?.setCommandValue('cmd', 'Body');

      const serialized = ref.current?.getValue() ?? '';
      expect(serialized).not.toContain('\u200B');
    });
  });

  describe('slash command integration path', () => {
    it('supports clearSlashCommand then setCommandValue flow', async () => {
      const onSlashTrigger = vi.fn();
      const { ref, container } = renderEditor({ onSlashTrigger });
      const root = getEditorRoot(container);
      root.focus();

      // Simulate a typed slash command candidate.
      ref.current?.setValue('/build-tests');
      setCursorAtEnd(root);
      fireEvent.input(root);
      await waitForRaf();
      expect(onSlashTrigger).toHaveBeenCalled();

      // Mimic selection behavior from chat input area.
      ref.current?.clearSlashCommand();
      ref.current?.setCommandValue('build-tests', 'Run tests');

      const serialized = ref.current?.getValue() ?? '';
      expect(serialized).toContain('[/cmd:build-tests]\nRun tests\n[/cmd-end]');
      expect(serialized).not.toContain('/build-tests');
    });

    it('allows slash trigger immediately after restoring serialized command block', async () => {
      const onSlashTrigger = vi.fn();
      const { ref, container } = renderEditor({ onSlashTrigger });
      const root = getEditorRoot(container);
      root.focus();

      ref.current?.setValue('[/cmd:edge-cases]\nInvestigate\n[/cmd-end]');
      setCursorAtEnd(root);

      const sel = window.getSelection();
      const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
      const node = range?.startContainer;
      if (!node || node.nodeType !== Node.TEXT_NODE || !range) {
        throw new Error('Expected cursor to be inside trailing text node');
      }

      const textNode = node as Text;
      const offset = range.startOffset;
      textNode.textContent =
        (textNode.textContent ?? '').slice(0, offset) +
        '/' +
        (textNode.textContent ?? '').slice(offset);
      const nextRange = document.createRange();
      nextRange.setStart(textNode, offset + 1);
      nextRange.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(nextRange);

      fireEvent.input(root);
      await waitForRaf();
      expect(onSlashTrigger).toHaveBeenCalled();
      const latestCall = onSlashTrigger.mock.calls[onSlashTrigger.mock.calls.length - 1]?.[0];
      expect(latestCall.searchText).toBe('');
    });
  });
});

describe('AgentsMentionsEditor placeholder', () => {
  it('shares one grid cell with the editor so a wrapped hint grows the editor instead of overlapping', () => {
    const { container } = render(
      <AgentsMentionsEditor
        onTrigger={vi.fn()}
        onCloseTrigger={vi.fn()}
        placeholder="Press Re-run step to restart this step — typing will not resume it"
      />,
    );
    const editor = getEditorRoot(container);
    const wrapper = editor.parentElement;
    const placeholder = wrapper?.firstElementChild;

    expect(wrapper).toHaveClass('grid', 'grid-cols-1');
    expect(placeholder).toHaveTextContent('typing will not resume it');
    expect(placeholder).toHaveClass('col-start-1', 'row-start-1', 'pointer-events-none');
    expect(placeholder).not.toHaveClass('absolute', 'truncate');
    expect(editor).toHaveClass('col-start-1', 'row-start-1', 'relative');
  });

  // A faded muted ink (e.g. /60) drops the hint below WCAG AA on the composer's glass.
  it('writes the hint in full-strength muted ink', () => {
    const { container } = render(
      <AgentsMentionsEditor onTrigger={vi.fn()} onCloseTrigger={vi.fn()} placeholder="Ask" />,
    );
    const placeholder = getEditorRoot(container).parentElement?.firstElementChild;
    expect(placeholder?.className).toMatch(/(^|\s)text-muted-foreground(\s|$)/);
  });
});
