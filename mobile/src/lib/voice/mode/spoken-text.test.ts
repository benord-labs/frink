import { describe, expect, it } from 'vitest';
import { spokenText } from './spoken-text';

describe('spokenText', () => {
  it('leaves out fenced code, diffs and tables, and says it did', () => {
    const reply = [
      'I fixed the bug.',
      '```ts',
      'const answer = 42;',
      '```',
      '```diff',
      '- old line',
      '+ new line',
      '```',
      '| File | Change |',
      '| --- | --- |',
      '| a.ts | +2 |',
      'Tests pass now.',
    ].join('\n');
    expect(spokenText(reply, true)).toEqual({
      sentences: ['I fixed the bug.', 'Tests pass now.'],
      hidden: true,
    });
  });

  it('turns links into their text and drops formatting marks', () => {
    expect(
      spokenText('See **the [setup guide](https://example.com/setup)** and `bun test`.', true)
        .sentences,
    ).toEqual(['See the setup guide and bun test.']);
    expect(spokenText('Docs: https://example.com/a/b', true).sentences).toEqual(['Docs: a link']);
  });

  it('drops headings and list markers but keeps their words', () => {
    expect(spokenText('## Summary\n- First thing\n2. Second thing', true).sentences).toEqual([
      'Summary',
      'First thing',
      'Second thing',
    ]);
  });

  it('leaves out a line that is only a file path', () => {
    expect(spokenText('Changed:\nsrc/lib/voice/turn.ts\n`mobile/App.tsx`', true)).toEqual({
      sentences: ['Changed:'],
      hidden: true,
    });
  });

  it('splits sentences, keeping closing quotes and brackets', () => {
    expect(spokenText('It works! Does it? Yes (mostly.) "Done."', true).sentences).toEqual([
      'It works!',
      'Does it?',
      'Yes (mostly.)',
      '"Done."',
    ]);
  });

  it('holds back the unfinished end of text still arriving', () => {
    expect(spokenText('First one. Second', false).sentences).toEqual(['First one.']);
    expect(spokenText('First one. Version 3.', false).sentences).toEqual(['First one.']);
    expect(spokenText('First one. Version 3. ', false).sentences).toEqual([
      'First one.',
      'Version 3.',
    ]);
    expect(spokenText('Line one\nLine', false).sentences).toEqual(['Line one']);
  });

  it('treats an unclosed fence as code to the end', () => {
    expect(spokenText('Here it is:\n```\nrm -rf build. And more.', false)).toEqual({
      sentences: ['Here it is:'],
      hidden: true,
    });
  });

  const intro = ['Intro.', 'After.'];
  it.each([
    ['a longer fence is not closed by a shorter one', '````md\n```\nconst x = 1;\n````', intro],
    ['a fence is not closed by the other mark', '~~~\n```\nconst x = 1;\n~~~', intro],
    ['a fence is not closed by one with text after it', '```\n```ts\nconst x = 1;\n```', intro],
    ['tildes fence code too', '~~~~\nconst x = 1;\n~~~~~', intro],
    [
      'a list mark inside code does not close it',
      '```md\n- ```\nrm -rf build. Then x.\n```',
      intro,
    ],
    [
      'an indented fence is still a fence',
      '- Step:\n    ```sh\n    rm -rf x. Then y.\n    ```',
      ['Intro.', 'Step:', 'After.'],
    ],
  ])('%s', (_name, code, sentences) => {
    expect(spokenText(`Intro.\n${code}\nAfter.`, true)).toEqual({ sentences, hidden: true });
  });

  it('finds fences, tables and paths inside quotes and lists', () => {
    const reply = '> ```\n> const x = 1;\n> ```\n- src/lib/voice/turn.ts\n> | a | b |\nDone.';
    expect(spokenText(reply, true)).toEqual({ sentences: ['Done.'], hidden: true });
  });

  it('reads Windows line endings, comparisons and a path ending a sentence', () => {
    expect(spokenText('Hi.\r\n```\r\ncode\r\n```\r\nBye.', true).sentences).toEqual([
      'Hi.',
      'Bye.',
    ]);
    expect(spokenText('Use x<3 and y>2 here.', true).sentences).toEqual(['Use x<3 and y>2 here.']);
    expect(spokenText('Use i<n and j>0, <b>bold</b>.', true).sentences).toEqual([
      'Use i<n and j>0, bold.',
    ]);
    expect(spokenText('src/lib/voice/turn.ts.', true)).toEqual({ sentences: [], hidden: true });
  });

  it('marks nothing hidden for a path-like line still arriving that may turn into prose', () => {
    expect(spokenText('Okay.\n`src/x.t', false)).toEqual({ sentences: ['Okay.'], hidden: false });
  });

  it('reads words joined by a slash, which are not a path', () => {
    expect(spokenText('Yes/No\nand/or.', true)).toEqual({
      sentences: ['Yes/No', 'and/or.'],
      hidden: false,
    });
  });

  it('reads a line of inline code fences as prose', () => {
    expect(spokenText('```inline``` is fine.', true).sentences).toEqual(['inline is fine.']);
  });

  it('keeps code hidden while a fence is still open and arriving', () => {
    const streaming = 'Here:\n````\n```\nconst x = 1. Then more. ';
    expect(spokenText(streaming, false)).toEqual({ sentences: ['Here:'], hidden: true });
    expect(spokenText(`${streaming}\n\`\``, false).sentences).toEqual(['Here:']);
  });

  it('reads a link as its text, even one holding a full stop', () => {
    expect(spokenText('[Read this. Then stop](https://example.com) now.', true).sentences).toEqual([
      'Read this.',
      'Then stop now.',
    ]);
    expect(spokenText('Docs at https://x.y/z. Next one.', true).sentences).toEqual([
      'Docs at a link.',
      'Next one.',
    ]);
  });

  it('holds back a link, code span or tag that is only half arrived', () => {
    expect(spokenText('Okay. [Read this. Then st', false).sentences).toEqual(['Okay.']);
    expect(spokenText('Okay. [Read this. Then stop](https://exa', false).sentences).toEqual([
      'Okay.',
    ]);
    expect(spokenText('Okay. Run `bun test. Th', false).sentences).toEqual(['Okay.']);
    expect(spokenText('Okay. <a href="x. y', false).sentences).toEqual(['Okay.']);
    expect(spokenText('See [1] here. Next', false).sentences).toEqual(['See [1] here.']);
  });

  it.each([
    'Okay. I looked at it. ```js\ncode\n```\nThe fix is in. Run it again!',
    '## Plan\n- Read the [guide](https://x.y/z). Then **run** `bun test`.\n1. Done! Next?\n| a |\nEnd.',
    'Version 3.5 works. "Quoted." (Aside.) Last',
    'Okay. [Read this. Then stop](https://example.com/a.b). ![x. y](i.png) Run `a. b` now. End.',
    'Intro.\n````md\n```\nconst x = 1;\n````\n~~~\ncode. here.\n~~~\nAfter. <b>Bold. text</b> done.',
    'See https://x.y/z. Then (https://a.b/c). Done.',
    'Use x<3 now. Then y>2 here. A <b>bold. one</b> too. i<n and j>0 ok.',
  ])('never takes back a sentence as text grows: %j', (full) => {
    let given: string[] = [];
    for (let end = 1; end <= full.length; end++) {
      const sentences = spokenText(full.slice(0, end), false).sentences;
      expect(sentences.slice(0, given.length)).toEqual(given);
      given = sentences;
    }
    expect(spokenText(full, true).sentences.slice(0, given.length)).toEqual(given);
  });

  it('gives nothing for punctuation or blank lines', () => {
    expect(spokenText('\n\n—\n...\n', true)).toEqual({ sentences: [], hidden: false });
  });
});
