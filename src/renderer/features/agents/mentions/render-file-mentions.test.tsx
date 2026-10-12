// @vitest-environment happy-dom
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { encodeForMentionToken } from '../../../../shared/lib/mentions/mention-token-codec';
import { extractTextMentions, RenderFileMentions } from './render-file-mentions';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

describe('RenderFileMentions', () => {
  it('renders each token as a chip between the text around it', () => {
    const { container } = render(
      <RenderFileMentions text="open @[file:local:src/a.ts] and @[skill:deploy] now" />,
    );

    expect(container.textContent).toBe('open a.ts and deploy now');
    expect(container.querySelector('[title="local:src/a.ts"]')?.textContent).toBe('a.ts');
    expect(container.querySelector('[title="Skill: deploy"]')?.textContent).toBe('deploy');
  });

  it('renders adjacent tokens at the start and end of the text with nothing between them', () => {
    const { container } = render(<RenderFileMentions text="@[agent:a]@[agent:b]" />);

    expect(container.textContent).toBe('ab');
    expect(container.querySelectorAll('[title^="Agent: "]')).toHaveLength(2);
  });

  it('shows a token that does not parse as the text it was written as', () => {
    const text = 'see @[image:local:a.png] and @[file:README.md]';
    const { container } = render(<RenderFileMentions text={text} />);

    expect(container.textContent).toBe(text);
    expect(container.querySelectorAll('[title]')).toHaveLength(0);
  });

  it('renders the same markup for the same text on a second mount', () => {
    const text = 'a @[skill:x] b @[agent:y]';
    const first = render(<RenderFileMentions text={text} />);
    const second = render(<RenderFileMentions text={text} />);

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
