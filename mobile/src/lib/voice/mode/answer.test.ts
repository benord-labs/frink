import { describe, expect, it } from 'vitest';
import type {
  MobileChatDetail,
  MobilePermission,
  MobileQuestion,
} from '@frink/shared/types/remote/mobile';
import {
  answerRequest,
  decideAnswer,
  normalize,
  openDecision,
  sameRequestId,
  type Answer,
  type Ask,
} from './answer';

const permissionAsk: Ask = { kind: 'permission', id: 'p1' };
const questionAsk: Ask = {
  kind: 'question',
  id: 'q1',
  question: 'Which database?',
  options: ['Postgres', 'SQLite', 'Use both'],
};

function permission(change: Partial<MobilePermission> = {}): MobilePermission {
  return {
    requestId: 'p1',
    chatId: 'chat-1',
    subChatId: 'sub-1',
    title: 'Bash',
    description: 'Run the test suite\n\n{\n  "command": "npm test"\n}',
    supported: true,
    ...change,
  };
}

function question(change: Partial<MobileQuestion> = {}): MobileQuestion {
  return {
    id: 'q1',
    source: 'live',
    chatId: 'chat-1',
    subChatId: 'sub-1',
    title: 'A question',
    questions: [
      {
        question: 'Which database?',
        header: 'Database',
        multiSelect: false,
        options: [
          { label: 'Postgres', description: '' },
          { label: 'SQLite', description: '' },
        ],
      },
    ],
    ...change,
  };
}

function chat(change: Partial<MobileChatDetail> = {}): MobileChatDetail {
  return {
    chat: { id: 'chat-1', name: 'Chat', projectId: null },
    subChatId: 'sub-1',
    subChats: [],
    messages: [],
    hasMore: false,
    activity: 'running',
    kind: 'chat',
    error: null,
    questions: [],
    permissions: [],
    pendingPlanId: null,
    ...change,
  };
}

describe('decideAnswer', () => {
  it.each(['yes', 'Yes.', 'Allow!', 'approve', 'Allow it.', 'allow once', '  ALLOW  '])(
    'approves on exactly "%s"',
    (said) => {
      expect(decideAnswer(permissionAsk, said, true)).toEqual({
        kind: 'permission',
        id: 'p1',
        approved: true,
      });
    },
  );

  it.each(['no', 'No.', 'deny', 'Deny it', 'Don’t allow.', "don't allow", 'do not allow'])(
    'denies on exactly "%s"',
    (said) => {
      expect(decideAnswer(permissionAsk, said, true)).toMatchObject({ approved: false });
    },
  );

  it.each([
    'yes I think so',
    "no don't allow that yet, yes",
    'yes no',
    'yeah',
    'allowed',
    'allow it now',
    'I allow',
    'not allow',
    'yes, but only once',
    '',
    'yes yes',
  ])('settles nothing on "%s"', (said) => {
    expect(decideAnswer(permissionAsk, said, true)).toBeNull();
  });

  it('settles nothing on a partial result, however clear', () => {
    expect(decideAnswer(permissionAsk, 'allow', false)).toBeNull();
    expect(decideAnswer(questionAsk, '1', false)).toBeNull();
  });

  it.each([
    ['1', 'Postgres'],
    ['one', 'Postgres'],
    ['Option two.', 'SQLite'],
    ['option 3', 'Use both'],
    ['sqlite', 'SQLite'],
    ['Use both.', 'Use both'],
  ])('a question takes "%s" as %s', (said, label) => {
    expect(decideAnswer(questionAsk, said, true)).toEqual({
      kind: 'question',
      id: 'q1',
      question: 'Which database?',
      label,
    });
  });

  it.each(['four', 'the first one', 'postgres please', 'both', 'yes'])(
    'a question settles nothing on "%s"',
    (said) => {
      expect(decideAnswer(questionAsk, said, true)).toBeNull();
    },
  );

  it('an empty or punctuation-only transcript never picks a choice with no words', () => {
    const ask: Ask = { ...questionAsk, options: ['👍', 'Later'] };
    expect(decideAnswer(ask, '.', true)).toBeNull();
    expect(decideAnswer(ask, '', true)).toBeNull();
  });

  it('a label that is also another option’s number is not a clear answer', () => {
    const ask: Ask = { ...questionAsk, options: ['2', 'Later'] };
    expect(decideAnswer(ask, '2', true)).toBeNull();
  });

  it('normalizes case, apostrophes and punctuation only', () => {
    expect(normalize('  Don’t   ALLOW!! ')).toBe('dont allow');
  });
});

describe('openDecision', () => {
  const ON_SCREEN_LINE = 'The details are on screen. Say allow or deny.';
  it.each([
    ['a shell command', 'Permission requested', 'Tool: Bash\n\nnpm install left-pad'],
    ['a description that is itself a command', 'Permission requested', 'npm install left-pad'],
    ['a file write', 'Permission requested', 'Write the config\n\n/Users/me/project/.env'],
    [
      'a web fetch',
      'Permission requested',
      'Fetch the docs\n\n{\n  "url": "https://example.com/secret?token=abc"\n}',
    ],
    ['a long description', 'Permission requested', `${'word '.repeat(60)}secret-tail`],
  ])('names no detail of %s', (_name, title, description) => {
    const decision = openDecision(chat({ permissions: [permission({ title, description })] }));
    expect(decision).toEqual({
      id: 'permission:p1',
      line: `Frink is asking permission. ${ON_SCREEN_LINE}`,
      ask: { kind: 'permission', id: 'p1' },
    });
  });

  it('names an add-on tool by its plain name, and nothing it was given', () => {
    const description = 'Create an issue\n\n{\n  "title": "rm -rf /"\n}';
    const line = (title: string) =>
      openDecision(chat({ permissions: [permission({ title, description })] }))?.line;
    expect(line('mcp__github__create_issue')).toBe(
      `Frink is asking permission to use the create issue tool. ${ON_SCREEN_LINE}`,
    );
    expect(line('mcp__plugin_linear_linear__getIssueById')).toBe(
      `Frink is asking permission to use the get issue by id tool. ${ON_SCREEN_LINE}`,
    );
    expect(line('mcp__x__oneTwo_three_four_fiveSix')).toBe(
      `Frink is asking permission. ${ON_SCREEN_LINE}`,
    );
    expect(line('Bash')).toBe(`Frink is asking permission. ${ON_SCREEN_LINE}`);
  });

  it('says a request to move the chat is answered on the computer', () => {
    const move = permission({
      title: 'Move chat',
      description: 'Move to Secret Project. Review this on your computer.',
      supported: false,
    });
    expect(openDecision(chat({ permissions: [move] }))?.line).toBe(
      'Frink is asking permission to move this chat. The details are on screen. Answer it on your computer.',
    );
  });

  it('a permission the phone may not answer is asked on the computer, with no voice answer', () => {
    const decision = openDecision(chat({ permissions: [permission({ supported: false })] }));
    expect(decision).toMatchObject({ ask: null });
    expect(decision?.line).toContain('Answer it on your computer.');
  });

  it('reads a single-choice question with numbered options', () => {
    expect(openDecision(chat({ questions: [question()] }))).toEqual({
      id: 'question:q1',
      line: 'Frink asks: Which database? 1: Postgres. 2: SQLite. Say a number.',
      ask: {
        kind: 'question',
        id: 'q1',
        question: 'Which database?',
        options: ['Postgres', 'SQLite'],
      },
    });
  });

  it('leaves multi-select, free-text and multi-part questions to the screen', () => {
    const [first] = question().questions;
    const multi = question({ questions: [{ ...first, multiSelect: true }] });
    const free = question({ questions: [] });
    const two = question({ questions: [first, { ...first, question: 'And?' }] });
    for (const prompt of [multi, free, two])
      expect(openDecision(chat({ questions: [prompt] }))).toMatchObject({ ask: null });
  });

  it('leaves a question to the screen when it or a choice holds code, a table or a path', () => {
    const [first] = question().questions;
    const options = (...labels: string[]) => labels.map((label) => ({ label, description: '' }));
    const asked = (change: Partial<typeof first>) =>
      openDecision(chat({ questions: [question({ questions: [{ ...first, ...change }] })] }));
    expect(asked({ options: options('src/lib/db.ts', 'SQLite') })).toMatchObject({ ask: null });
    expect(asked({ question: 'Run this?\n```sh\nrm -rf build\n```' })).toMatchObject({ ask: null });
    expect(asked({ question: 'Use **[Postgres](https://x.y)**?' })?.line).toBe(
      'Frink asks: Use Postgres? 1: Postgres. 2: SQLite. Say a number.',
    );
  });

  it('asks permissions before questions, and nothing when none is open', () => {
    const both = chat({ permissions: [permission()], questions: [question()] });
    expect(openDecision(both)?.id).toBe('permission:p1');
    expect(openDecision(chat())).toBeNull();
  });
});

describe('answerRequest', () => {
  it('gives an answer to the same decision the same request id each time', () => {
    const ids = new Map<string, string>();
    let made = 0;
    const fresh = () => `req-${++made}`;
    expect(sameRequestId(ids, 'p1', fresh)).toBe('req-1');
    expect(sameRequestId(ids, 'q1', fresh)).toBe('req-2');
    expect(sameRequestId(ids, 'p1', fresh)).toBe('req-1');
  });

  it('approves the permission that is still open', () => {
    const data = chat({ permissions: [permission()] });
    expect(answerRequest({ kind: 'permission', id: 'p1', approved: true }, data, 'req-1')).toEqual({
      type: 'respondPermission',
      requestId: 'p1',
      chatId: 'chat-1',
      subChatId: 'sub-1',
      approved: true,
    });
  });

  it('sends nothing for a permission that closed or that the phone may not answer', () => {
    const given: Answer = { kind: 'permission', id: 'p1', approved: true };
    expect(answerRequest(given, chat(), 'req-1')).toBeNull();
    expect(
      answerRequest(given, chat({ permissions: [permission({ supported: false })] }), 'req-1'),
    ).toBeNull();
  });

  it('answers the question under its own source and a fresh request id', () => {
    const data = chat({ questions: [question({ source: 'parked' })] });
    const given: Answer = {
      kind: 'question',
      id: 'q1',
      question: 'Which database?',
      label: 'SQLite',
    };
    expect(answerRequest(given, data, 'req-2')).toEqual({
      type: 'answerQuestion',
      id: 'q1',
      source: 'parked',
      chatId: 'chat-1',
      subChatId: 'sub-1',
      answers: { 'Which database?': 'SQLite' },
      requestId: 'req-2',
    });
    expect(answerRequest(given, chat(), 'req-3')).toBeNull();
  });
});
