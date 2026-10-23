import { describe, expect, it } from 'vitest';
import {
  buildTrayModel,
  EMPTY_SAVED,
  isInlineCommand,
  type TrayLive,
  type TraySaved,
} from './model';

const NOW = Date.UTC(2026, 9, 23, 12);
const MINUTE = 60_000;

function live(overrides: Partial<TrayLive> = {}): TrayLive {
  return {
    permissions: [],
    questions: [],
    working: [],
    canApprove: true,
    ...overrides,
  };
}

function saved(
  names: Record<string, string | null>,
  overrides: Partial<TraySaved> = {},
): TraySaved {
  return { ...EMPTY_SAVED, names: new Map(Object.entries(names)), ...overrides };
}

function command(chatId: string, text: string): TrayLive['permissions'][number] {
  return {
    chatId,
    subChatId: `${chatId}-sub`,
    requestId: `r-${chatId}`,
    command: text,
  };
}

describe('buildTrayModel', () => {
  it('offers Allow and Deny for a short one-line command while Frink can carry it on', () => {
    const model = buildTrayModel(
      live({ permissions: [command('a', 'bun test checkout')] }),
      saved({ a: 'Fix the checkout bug' }),
      [],
      NOW,
    );

    expect(model.needs).toEqual([
      {
        key: 'permission:r-a',
        title: 'Fix the checkout bug',
        detail: 'Wants to run a command',
        target: { chatId: 'a', subChatId: 'a-sub' },
        approval: {
          chatId: 'a',
          subChatId: 'a-sub',
          requestId: 'r-a',
          command: 'bun test checkout',
        },
      },
    ]);
  });

  it('sends a command to Frink when the window is not ready to carry it on', () => {
    const model = buildTrayModel(
      live({ permissions: [command('a', 'bun test')], canApprove: false }),
      saved({ a: 'Chat' }),
      [],
      NOW,
    );

    expect(model.needs[0].approval).toBeUndefined();
    expect(model.needs[0].target).toEqual({ chatId: 'a', subChatId: 'a-sub' });
  });

  it.each([
    ['a long command', 'x'.repeat(61)],
    ['a multi-line command', 'cat <<EOF\nhi\nEOF'],
  ])('never offers inline Allow for %s', (_label, text) => {
    const model = buildTrayModel(
      live({ permissions: [command('a', text)] }),
      saved({ a: 'Chat' }),
      [],
      NOW,
    );

    expect(model.needs[0]).toMatchObject({ detail: 'Wants your permission' });
    expect(model.needs[0].approval).toBeUndefined();
  });

  it('sends tool and move requests to Frink without offering inline answers', () => {
    const model = buildTrayModel(
      live({ permissions: [{ chatId: 'a', subChatId: 'a-sub', requestId: 'r' }] }),
      saved({ a: 'One' }),
      [],
      NOW,
    );

    expect(model.needs[0]).toMatchObject({
      detail: 'Wants your permission',
      target: { chatId: 'a' },
    });
    expect(model.needs[0].approval).toBeUndefined();
  });

  it('lists each chat once, a permission before a question, plans and Flow approvals after', () => {
    const model = buildTrayModel(
      live({
        permissions: [command('a', 'ls')],
        questions: [
          { chatId: 'a', subChatId: 'a-sub' },
          { chatId: 'b', subChatId: 'b-sub' },
        ],
      }),
      saved(
        { a: 'One', b: 'Two', c: 'Three', 'task:8': 'Triage new issues' },
        {
          waits: [
            { key: 'b', kind: 'attention' },
            { key: 'c', kind: 'plan' },
            { key: 'task:8', kind: 'attention' },
            { key: 'task:9', kind: 'attention' },
          ],
          approvals: [{ flowRunId: 'run', flowName: 'Nightly release', message: null }],
        },
      ),
      [],
      NOW,
    );

    expect(model.needs.map(({ title, detail, target }) => [title, detail, target])).toEqual([
      ['One', 'Wants to run a command', { chatId: 'a', subChatId: 'a-sub' }],
      ['Two', 'Asked you a question', { chatId: 'b', subChatId: 'b-sub' }],
      ['Three', 'Has a plan for you to review', { chatId: 'c' }],
      ['Triage new issues', 'Needs your input', { view: 'workqueue' }],
      ['A task in the Work Queue', 'Needs your input', { view: 'workqueue' }],
      ['Nightly release', 'Waiting for your approval', { view: 'workqueue' }],
    ]);
  });

  it('leaves out chats that are archived or not looked up yet', () => {
    const model = buildTrayModel(
      live({
        permissions: [command('gone', 'ls')],
        working: [{ chatId: 'new', subChatId: 's', held: false, activity: 'Working' }],
      }),
      saved({ gone: null }),
      [],
      NOW,
    );

    expect(model).toEqual({ needs: [], working: [], done: [] });
  });

  it('shows what working chats are doing, and background waits as waiting', () => {
    const model = buildTrayModel(
      live({
        working: [
          { chatId: 'b', subChatId: 'b1', held: true, activity: 'Thinking' },
          { chatId: 'a', subChatId: 'a1', held: false, activity: 'Running a command' },
          { chatId: 'a', subChatId: 'a2', held: true, activity: 'Thinking' },
        ],
      }),
      saved({ a: 'One', b: 'Two' }),
      [],
      NOW,
    );

    expect(model.working.map(({ title, detail, target }) => [title, detail, target])).toEqual([
      ['One', 'Running a command', { chatId: 'a', subChatId: 'a1' }],
      ['Two', 'Waiting on background work', { chatId: 'b', subChatId: 'b1' }],
    ]);
  });

  it('keeps a chat that needs you out of Working', () => {
    const model = buildTrayModel(
      live({
        questions: [{ chatId: 'a', subChatId: 'a1' }],
        working: [{ chatId: 'a', subChatId: 'a1', held: false, activity: 'Working' }],
      }),
      saved({ a: 'One' }),
      [],
      NOW,
    );

    expect(model.needs).toHaveLength(1);
    expect(model.working).toEqual([]);
  });

  it('shows the last hour of finished chats, newest first, three at most, once each', () => {
    const completions = [
      { chatId: 'a', subChatId: 'a1', at: NOW - 2 * MINUTE },
      { chatId: 'b', subChatId: 'b1', at: NOW - 30_000 },
      { chatId: 'a', subChatId: 'a1', at: NOW - 5 * MINUTE },
      { chatId: 'c', subChatId: 'c1', at: NOW - 10 * MINUTE },
      { chatId: 'd', subChatId: 'd1', at: NOW - 20 * MINUTE },
      { chatId: 'e', subChatId: 'e1', at: NOW - 61 * MINUTE },
    ];
    const model = buildTrayModel(
      live(),
      saved({ a: 'A', b: 'B', c: 'C', d: 'D', e: 'E' }),
      completions,
      NOW,
    );

    expect(model.done.map(({ title, detail }) => [title, detail])).toEqual([
      ['B', 'Finished just now'],
      ['A', 'Finished 2 min ago'],
      ['C', 'Finished 10 min ago'],
    ]);
  });

  it('keeps a chat under Working, not Done, while another of its tabs waits on background work', () => {
    const model = buildTrayModel(
      live({ working: [{ chatId: 'a', subChatId: 'a2', held: true, activity: 'Working' }] }),
      saved({ a: 'A' }),
      [{ chatId: 'a', subChatId: 'a1', at: NOW - MINUTE }],
      NOW,
    );

    expect(model.working.map(({ title, detail }) => [title, detail])).toEqual([
      ['A', 'Waiting on background work'],
    ]);
    expect(model.done).toEqual([]);
  });
});

describe('isInlineCommand', () => {
  it.each([
    ['bun test', true],
    ['   ', false],
    ['x'.repeat(60), true],
    ['x'.repeat(61), false],
    ['a\nb', false],
    ['a\rb', false],
  ])('%j → %s', (text, expected) => {
    expect(isInlineCommand(text)).toBe(expected);
  });
});
