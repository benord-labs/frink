// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFileIconByExtension } from '@/lib/mentions/agents-file-mention-icons';
import { encodeForMentionToken } from '../../../../shared/lib/mentions/mention-token-codec';
import { type ParsedMention, parseMention } from '../../../../shared/lib/mentions/parse-mention';
import { TooltipProvider } from '../../../components/ui/tooltip';
import {
  extractTextMentions,
  MentionChip,
  RenderFileMentions,
  TextMentionBlocks,
} from './render-file-mentions';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

afterEach(cleanup);

function renderInApp(node: ReactNode) {
  return render(<TooltipProvider>{node}</TooltipProvider>);
}

function mentionFor(id: string): ParsedMention {
  const mention = parseMention(id);
  if (!mention) throw new Error(`Not a mention: ${id}`);
  return mention;
}

/** The chip drawn for the mention `id`, found by its label. */
function renderChip(id: string, label: string): HTMLElement {
  renderInApp(<MentionChip mention={mentionFor(id)} />);
  const chip = screen.getByText(label).parentElement;
  if (!chip) throw new Error(`No chip for ${label}`);
  return chip;
}

/** Focuses the chip, as a keyboard user would, and returns the tooltip it opens. */
function openTooltip(chip: HTMLElement): HTMLElement {
  fireEvent.focus(chip);
  return screen.getByRole('tooltip');
}

function tooltipPanel(): Element | null {
  return document.querySelector('[data-tooltip="true"]');
}

describe('MentionChip', () => {
  it('draws a file with its file-type icon and shows its full path in the tooltip', () => {
    const chip = renderChip('file:local:src/renderer/a.ts', 'a.ts');
    const TsIcon = getFileIconByExtension('a.ts');
    const expected = render(<TsIcon />).container.innerHTML;

    expect(chip.querySelector('svg')?.outerHTML).toBe(expected);
    expect(openTooltip(chip)).toHaveTextContent('src/renderer/a.ts');
    expect(tooltipPanel()).toHaveClass('font-mono', 'wrap-anywhere');
  });

  it('draws a folder with the folder icon and shows its full path in the tooltip', () => {
    const chip = renderChip('folder:local:src/renderer', 'renderer');

    expect(chip.querySelector('svg')).toHaveClass('lucide-folder-open');
    expect(openTooltip(chip)).toHaveTextContent('src/renderer');
    expect(tooltipPanel()).toHaveClass('font-mono');
  });

  it('names a skill in its tooltip instead of a path', () => {
    const chip = renderChip('skill:deploy', 'deploy');

    expect(chip.querySelector('svg')).toHaveClass('lucide-tool-case');
    expect(openTooltip(chip)).toHaveTextContent('Skill: deploy');
    expect(tooltipPanel()).not.toHaveClass('font-mono');
  });

  it('draws a code selection with its file-type icon and line range, as the composer strip does', () => {
    const chip = renderChip(`code:send.ts:12-40:x:${encodeForMentionToken('x')}`, 'send.ts');
    const TsIcon = getFileIconByExtension('send.ts');

    expect(chip.querySelector('svg')?.outerHTML).toBe(render(<TsIcon />).container.innerHTML);
    expect(chip).toHaveTextContent('send.tsL12-40');
  });
});

describe('TextMentionBlocks', () => {
  it('draws quote, pasted and diff mentions as badges with their first line, size or line', () => {
    const mentions = [
      `quote:Keep the retry\nand the backoff:${encodeForMentionToken('Keep the retry')}`,
      'pasted:2048:Build a flow\nthat runs nightly|/tmp/p.txt',
      `diff:src/main/socket.ts:7:x:${encodeForMentionToken('x')}`,
    ].map(mentionFor);
    renderInApp(<TextMentionBlocks mentions={mentions} />);

    expect(screen.getByText('Keep the retry')).toBeInTheDocument();
    expect(screen.getByText('Build a flow').nextElementSibling).toHaveTextContent('2.0 KB');
    expect(screen.getByText('socket.ts').nextElementSibling).toHaveTextContent('L7');
    expect(document.querySelectorAll('.lucide-square-dashed-text')).toHaveLength(2);
  });

  it('names a diff in a Windows path by its file name', () => {
    const mention = mentionFor(`diff:src\\main\\socket.ts:7:x:${encodeForMentionToken('x')}`);
    renderInApp(<TextMentionBlocks mentions={[mention]} />);

    expect(screen.getByText('socket.ts').nextElementSibling).toHaveTextContent('L7');
  });
});

describe('RenderFileMentions', () => {
  it('renders each token as a chip between the text around it', () => {
    const { container } = renderInApp(
      <RenderFileMentions text="open @[file:local:src/a.ts] and @[skill:deploy] now" />,
    );

    expect(container.textContent).toBe('open a.ts and deploy now');
    expect(container.querySelectorAll('[tabindex="0"]')).toHaveLength(2);
  });

  it('renders adjacent tokens at the start and end of the text with nothing between them', () => {
    const { container } = renderInApp(<RenderFileMentions text="@[agent:a]@[agent:b]" />);

    expect(container.textContent).toBe('ab');
    expect(container.querySelectorAll('[tabindex="0"]')).toHaveLength(2);
  });

  it('shows a token that does not parse as the text it was written as', () => {
    const text = 'see @[image:local:a.png] and @[file:README.md]';
    const { container } = renderInApp(<RenderFileMentions text={text} />);

    expect(container.textContent).toBe(text);
    expect(container.querySelectorAll('[tabindex="0"]')).toHaveLength(0);
  });

  it('keeps chips out of the tab order inside a control that takes focus itself', () => {
    const { container } = renderInApp(
      <RenderFileMentions text="open @[file:local:src/a.ts] now" focusable={false} />,
    );

    expect(screen.getByText('a.ts')).toBeInTheDocument();
    expect(container.querySelectorAll('[tabindex]')).toHaveLength(0);
  });

  it('renders the same markup for the same text on a second mount', () => {
    const text = 'a @[skill:x] b @[agent:y]';
    const first = renderInApp(<RenderFileMentions text={text} />);
    const second = renderInApp(<RenderFileMentions text={text} />);

    expect(second.container.innerHTML).toBe(first.container.innerHTML);
    expect(second.container.textContent).toBe('a x b y');
  });
});

describe('extractTextMentions', () => {
  it('lifts quote and pasted tokens out of the text and leaves the other tokens in place', () => {
    const quote = `@[quote:hi:${encodeForMentionToken('hi there')}]`;
    const text = `${quote}\n@[file:local:a.ts] hello\n@[pasted:5:hello|/tmp/p.txt]`;

    const { textMentions, cleanedText } = extractTextMentions(text);

    expect(textMentions.map((mention) => mention.fullText)).toStrictEqual(['hi there', 'hello']);
    expect(cleanedText).toBe('@[file:local:a.ts] hello');
  });

  it('leaves a diff token that does not parse in the text', () => {
    const text = 'x @[diff:src/a.ts:7] y';

    expect(extractTextMentions(text)).toStrictEqual({ textMentions: [], cleanedText: text });
  });
});
