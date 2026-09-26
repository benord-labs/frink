import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSION_PROMPT_TIMEOUT_MS } from '../permissions/constants';
import { QUESTION_TEXT_MAX } from '../trpc/routers/frink-task-signal';
import {
  buildAskUserQuestionParkSignal,
  clearPendingApprovals,
  holdQuestionUntilAnswered,
  listPendingQuestionProjections,
  pendingToolApprovals,
  resolvePendingToolApproval,
} from './ask-user-question-approval';

vi.mock('electron-log', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const recordLinkedTaskSignalMock = vi.hoisted(() => vi.fn());
// Spread the real module: the park pulls this in by dynamic import, and a bare object mock would
// strip every other export the module under test reaches for.
vi.mock('../trpc/routers/frink-task-signal-persist', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../trpc/routers/frink-task-signal-persist')>()),
  recordLinkedTaskSignal: recordLinkedTaskSignalMock,
}));

// Shape the SDK's AskUserQuestion tool actually sends.
const sdkQuestion = (overrides: Record<string, unknown> = {}) => ({
  question: 'Should the dead code be removed in this diff?',
  header: 'Diff scope',
  multiSelect: false,
  options: [
    { label: 'Fix + remove dead code', description: 'One diff' },
    { label: 'Fix only', description: 'Cleanup separately' },
  ],
  ...overrides,
});

const fallbackQuestion = {
  question:
    'The agent asked a follow-up question that could not be displayed. Ask it to restate the choices, or type your answer.',
  header: 'Follow-up question',
  options: [
    {
      label: 'Ask again',
      description: 'Ask the agent to restate its question and available choices.',
    },
  ],
  multiSelect: false,
};

describe('buildAskUserQuestionParkSignal', () => {
  it('carries the tool payload into an awaiting_input park verbatim', () => {
    const signal = buildAskUserQuestionParkSignal({ questions: [sdkQuestion()] });
    expect(signal.state).toBe('awaiting_input');
    expect(signal.questions).toEqual([sdkQuestion()]);
  });

  it('summarises with the headers, not the question text (this is the work-queue line)', () => {
    const signal = buildAskUserQuestionParkSignal({
      questions: [sdkQuestion(), sdkQuestion({ header: 'Test depth' })],
    });
    expect(signal.summary).toBe('Needs your input: Diff scope, Test depth');
    expect(signal.summary).not.toContain('Should the dead code');
  });

  it('drops fields the signal contract does not declare (SDK-only per-option extras)', () => {
    const signal = buildAskUserQuestionParkSignal({
      questions: [sdkQuestion({ options: [{ label: 'Yes', description: 'do it', preview: 'x' }] })],
    });
    expect(signal.questions?.[0].options[0]).toEqual({ label: 'Yes', description: 'do it' });
  });

  it('clips over-long text rather than costing the user the whole clickable card', () => {
    const signal = buildAskUserQuestionParkSignal({
      questions: [sdkQuestion({ question: 'q'.repeat(QUESTION_TEXT_MAX + 400) })],
    });
    // Clipped, and still the real question with its real options — never the fallback card.
    expect(signal.questions?.[0].question).toHaveLength(QUESTION_TEXT_MAX);
    expect(signal.questions?.[0].header).toBe('Diff scope');
    expect(signal.questions?.[0].options).toHaveLength(2);
  });

  it('passes a question far longer than the old 500 bound through untouched', () => {
    const question = `Which scope should this take? (A) minimal — ${'a'.repeat(200)}, (B) moderate — ${'b'.repeat(200)}, (C) structural — ${'c'.repeat(200)}, (D) full rewrite — ${'d'.repeat(200)}`;
    expect(question.length).toBeGreaterThan(500);

    const signal = buildAskUserQuestionParkSignal({ questions: [sdkQuestion({ question })] });

    expect(signal.questions?.[0].question).toBe(question);
  });

  it('passes a question of exactly the cap through untouched (no off-by-one clip)', () => {
    const question = 'q'.repeat(QUESTION_TEXT_MAX);
    const signal = buildAskUserQuestionParkSignal({ questions: [sdkQuestion({ question })] });

    // The zod `.max` and the slice share one constant, so the boundary must agree: a question AT
    // the cap is neither clipped by one character nor rejected into the fallback card.
    expect(signal.questions?.[0].question).toBe(question);
  });

  it('never clips mid-emoji, which would leave an unpaired surrogate in the persisted signal', () => {
    // A lone surrogate is not a well-formed string: Postgres rejects it in jsonb, so a park write
    // carrying one fails and strands the question the user was asked.
    const question = `${'a'.repeat(QUESTION_TEXT_MAX - 1)}\u{1F600}${'b'.repeat(50)}`;
    const signal = buildAskUserQuestionParkSignal({ questions: [sdkQuestion({ question })] });

    const clipped = signal.questions?.[0].question ?? '';
    // A high surrogate with no low surrogate after it is a broken pair. Checked with a regex
    // because `String.prototype.isWellFormed` is ES2024 and this repo's tsconfig lib is ES2022.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(clipped)).toBe(false);
    expect(clipped.length).toBeLessThanOrEqual(QUESTION_TEXT_MAX);
  });

  it('keeps a character at the cut that only looks like a split pair', () => {
    // A lone high surrogate sitting exactly at the boundary, followed by an ordinary character —
    // not a straddling pair, so the cut must not step back and drop a character of real text.
    const question = `${'a'.repeat(QUESTION_TEXT_MAX - 1)}\uD800bbb`;
    const signal = buildAskUserQuestionParkSignal({ questions: [sdkQuestion({ question })] });

    expect(signal.questions?.[0].question).toBe(`${'a'.repeat(QUESTION_TEXT_MAX - 1)}�`);
  });

  it('replaces a lone surrogate already inside the provider text instead of persisting it', () => {
    const question = `before \uD800 after`;
    const signal = buildAskUserQuestionParkSignal({ questions: [sdkQuestion({ question })] });

    expect(signal.questions?.[0].question).toBe('before � after');
  });

  it('bounds provider question and option counts to the renderer recovery contract', () => {
    const signal = buildAskUserQuestionParkSignal({
      questions: Array.from({ length: 12 }, (_, index) =>
        sdkQuestion({
          header: `Question ${index}`,
          options: Array.from({ length: 22 }, (__, optionIndex) => ({
            label: `Option ${optionIndex}`,
            description: 'Choose this',
          })),
        }),
      ),
    });

    expect(signal.questions).toHaveLength(10);
    expect(signal.questions?.[0].options).toHaveLength(20);
  });

  it('filters malformed options without dropping the remaining answerable question', () => {
    const signal = buildAskUserQuestionParkSignal({
      questions: [
        sdkQuestion({
          options: [
            { label: '', description: 'invalid' },
            { label: 'Keep', description: 'valid', preview: 'SDK-only' },
          ],
        }),
      ],
    });

    expect(signal.questions?.[0].options).toEqual([{ label: 'Keep', description: 'valid' }]);
  });

  it('uses an answerable fallback when the payload is unusable — never silently continues', () => {
    const signal = buildAskUserQuestionParkSignal({ questions: 'not-an-array' });
    expect(signal.state).toBe('awaiting_input');
    expect(signal.questions).toEqual([fallbackQuestion]);
    expect(signal.summary).toBe('Needs your input: Follow-up question');
  });

  it('uses the same fallback when a question is structurally invalid (no options)', () => {
    const signal = buildAskUserQuestionParkSignal({ questions: [sdkQuestion({ options: [] })] });
    expect(signal.questions).toEqual([fallbackQuestion]);
  });

  it('falls back as a whole rather than silently dropping one malformed parallel question', () => {
    const signal = buildAskUserQuestionParkSignal({
      questions: [sdkQuestion(), sdkQuestion({ header: 'Missing choices', options: [] })],
    });
    expect(signal.questions).toEqual([fallbackQuestion]);
    expect(signal.summary).toBe('Needs your input: Follow-up question');
  });
});

describe('holdQuestionUntilAnswered', () => {
  const parkAndKill = vi.fn();
  const chunks: unknown[] = [];
  const hold = (
    toolUseID = 'tu-hold',
    subChatId = 'sub-1',
    toolInput: Record<string, unknown> = { questions: [sdkQuestion()] },
  ) =>
    holdQuestionUntilAnswered({
      toolUseID,
      toolInput,
      chatId: 'chat-1',
      subChatId,
      emitChunk: (c) => {
        chunks.push(c);
      },
      parkAndKill,
    });

  beforeEach(() => {
    vi.useRealTimers();
    chunks.length = 0;
    parkAndKill.mockReset().mockImplementation(async (_signal, onPersisted) => {
      onPersisted();
    });
  });

  // An answered hold leaves its map entry behind — eviction lives in respondToolApproval, not here
  // — so clean up after each test, or these leftovers are counted by the next describe.
  afterEach(() => {
    pendingToolApprovals.clear();
  });

  it('projects only the answerable UI fields and retires them with the provider hold', async () => {
    const promise = hold();

    expect(listPendingQuestionProjections('sub-1')).toEqual([
      {
        chatId: 'chat-1',
        subChatId: 'sub-1',
        toolUseId: 'tu-hold',
        questions: [sdkQuestion()],
      },
    ]);
    expect(resolvePendingToolApproval('tu-hold', { approved: true })).toBe(true);
    expect(listPendingQuestionProjections('sub-1')).toEqual([]);
    await promise;
  });

  it('uses the same bounded questions for the live card and crash-recovery projection', async () => {
    const promise = hold('tu-bounded', 'sub-bounded', {
      questions: Array.from({ length: 12 }, (_, index) =>
        sdkQuestion({
          header: `${index}-${'h'.repeat(150)}`,
          options: [
            { label: '', description: 'invalid' },
            ...Array.from({ length: 22 }, (__, optionIndex) => ({
              label: `Option ${optionIndex}`,
              description: 'Choose this',
            })),
          ],
        }),
      ),
    });

    const projection = listPendingQuestionProjections('sub-bounded')[0];
    // SAFETY: chunks is an untyped capture array; narrowing only by the `type` discriminant the
    // production emitter always sets, then reading the one field under test.
    const live = chunks.find(
      (chunk) => (chunk as { type?: string }).type === 'ask-user-question',
    ) as { questions?: unknown };
    expect(projection?.questions).toHaveLength(10);
    expect(projection?.questions[0].header).toHaveLength(120);
    expect(projection?.questions[0].options).toHaveLength(20);
    expect(live.questions).toEqual(projection?.questions);

    expect(resolvePendingToolApproval('tu-bounded', { approved: true })).toBe(true);
    await promise;
  });

  // The reported defect: the live card is built from the SAME normalized value as the park, so a
  // question longer than the old 500 bound reached the user cut off mid-sentence.
  it('emits a long question to the live card without clipping it', async () => {
    const question = `Which scope should this take? (A) minimal — ${'a'.repeat(200)}, (B) moderate — ${'b'.repeat(200)}, (C) structural — ${'c'.repeat(200)}, (D) full rewrite — ${'d'.repeat(200)}`;

    const promise = hold('tu-long', 'sub-long', { questions: [sdkQuestion({ question })] });

    // SAFETY: chunks is an untyped capture array; narrowing only by the `type` discriminant the
    // production emitter always sets, then reading the one field under test.
    const live = chunks.find(
      (chunk) => (chunk as { type?: string }).type === 'ask-user-question',
    ) as { questions?: Array<{ question: string }> } | undefined;
    expect(live?.questions?.[0].question).toBe(question);
    expect(listPendingQuestionProjections('sub-long')[0]?.questions[0].question).toBe(question);

    expect(resolvePendingToolApproval('tu-long', { approved: true })).toBe(true);
    await promise;
  });

  it('emits and parks one recoverable fallback when provider input is invalid', async () => {
    vi.useFakeTimers();
    void hold('tu-invalid', 'sub-invalid', {
      questions: [sdkQuestion({ options: [{ label: '', description: 'invalid' }] })],
    });

    expect(listPendingQuestionProjections('sub-invalid')).toEqual([
      expect.objectContaining({ toolUseId: 'tu-invalid', questions: [fallbackQuestion] }),
    ]);
    expect(chunks).toContainEqual(
      expect.objectContaining({ type: 'ask-user-question', questions: [fallbackQuestion] }),
    );
    await vi.advanceTimersByTimeAsync(PERMISSION_PROMPT_TIMEOUT_MS);
    expect(parkAndKill).toHaveBeenCalledWith(
      expect.objectContaining({ questions: [fallbackQuestion] }),
      expect.any(Function),
    );
  });

  it('raises the live question card so the held call has something to answer it', async () => {
    const promise = hold();
    expect(chunks).toContainEqual(
      expect.objectContaining({ type: 'ask-user-question', toolUseId: 'tu-hold' }),
    );
    expect(pendingToolApprovals.has('tu-hold')).toBe(true);
    pendingToolApprovals.get('tu-hold')?.resolve({ approved: true, updatedInput: { answers: {} } });
    await promise;
  });

  it('answers natively and never parks when the reply lands inside the window', async () => {
    const promise = hold();
    pendingToolApprovals
      .get('tu-hold')
      ?.resolve({ approved: true, updatedInput: { questions: [], answers: { q: 'Yes' } } });
    await expect(promise).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { questions: [], answers: { q: 'Yes' } },
    });
    expect(parkAndKill).not.toHaveBeenCalled();
  });

  // A stop/pause resolves every pending approval WITHOUT an answer. That is a real refusal, not a
  // park, so it must deny — treating it as an approval would let the blocking tool actually run.
  it('denies when the run is stopped rather than answered', async () => {
    const promise = hold();
    clearPendingApprovals('Paused by user.', 'sub-1');
    await expect(promise).resolves.toEqual({ behavior: 'deny', message: 'Paused by user.' });
    expect(parkAndKill).not.toHaveBeenCalled();
  });

  // The CLI replaces our deny message with its canned refusal before the model sees it, so the
  // transcript is the only place the real reason can still be told — without this the card renders
  // an ordinary Skip as a bare error.
  it('carries the refusal reason to the card, which the model-facing message cannot', async () => {
    const promise = hold();
    pendingToolApprovals.get('tu-hold')?.resolve({ approved: false, message: 'Skipped' });
    await promise;

    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: 'ask-user-question-result',
        toolUseId: 'tu-hold',
        result: 'Skipped',
      }),
    );
  });

  // The whole point of the design: on timeout the run parks and the subprocess dies with the tool
  // call UNANSWERED. Settling this promise would hand the model a tool result on its way out.
  it('parks and never answers the agent when the window expires', async () => {
    vi.useFakeTimers();
    let settled = false;
    void hold().then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(PERMISSION_PROMPT_TIMEOUT_MS);

    expect(parkAndKill).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'awaiting_input', questions: [sdkQuestion()] }),
      expect.any(Function),
    );
    // Removed only after the durable park callback, so teardown cannot resolve it either.
    expect(pendingToolApprovals.has('tu-hold')).toBe(false);
    expect(listPendingQuestionProjections('sub-1')).toEqual([]);
    // The live card is retired only once the durable parked answer surface exists.
    expect(chunks).toContainEqual(
      expect.objectContaining({ type: 'ask-user-question-timeout', toolUseId: 'tu-hold' }),
    );
    clearPendingApprovals('Execution ended.', 'sub-1');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);
  });

  it('rejects an answer while parking has won but persistence is still in flight', async () => {
    vi.useFakeTimers();
    let persist!: () => void;
    let settle!: () => void;
    parkAndKill.mockImplementation(
      (_signal, onPersisted) =>
        new Promise<void>((resolve) => {
          persist = onPersisted;
          settle = resolve;
        }),
    );
    void hold();

    await vi.advanceTimersByTimeAsync(PERMISSION_PROMPT_TIMEOUT_MS);
    expect(resolvePendingToolApproval('tu-hold', { approved: true })).toBe(false);
    expect(pendingToolApprovals.has('tu-hold')).toBe(true);
    expect(chunks).not.toContainEqual(
      expect.objectContaining({ type: 'ask-user-question-timeout' }),
    );

    persist();
    expect(pendingToolApprovals.has('tu-hold')).toBe(false);
    settle();
    await vi.runAllTimersAsync();
  });

  it('keeps a failed persistence answerable and surfaces the failure', async () => {
    vi.useFakeTimers();
    parkAndKill.mockRejectedValueOnce(new Error('database unavailable'));
    const promise = hold();

    await vi.advanceTimersByTimeAsync(PERMISSION_PROMPT_TIMEOUT_MS);
    expect(pendingToolApprovals.has('tu-hold')).toBe(true);
    expect(chunks).toContainEqual(
      expect.objectContaining({ type: 'error', errorText: expect.stringContaining('answerable') }),
    );
    const errorIndex = chunks.findIndex((chunk) => (chunk as { type?: string }).type === 'error');
    expect(
      chunks.findIndex(
        (chunk, index) =>
          index > errorIndex && (chunk as { type?: string }).type === 'ask-user-question',
      ),
    ).toBeGreaterThan(errorIndex);
    expect(
      resolvePendingToolApproval('tu-hold', {
        approved: true,
        updatedInput: { answers: { question: 'Yes' } },
      }),
    ).toBe(true);
    await expect(promise).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { answers: { question: 'Yes' } },
    });
  });

  it('honours a stop that races parking when persistence fails', async () => {
    vi.useFakeTimers();
    let rejectPark!: (error: Error) => void;
    parkAndKill.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPark = reject;
        }),
    );
    const promise = hold();

    await vi.advanceTimersByTimeAsync(PERMISSION_PROMPT_TIMEOUT_MS);
    clearPendingApprovals('Stopped by user.', 'sub-1');
    expect(pendingToolApprovals.has('tu-hold')).toBe(true);

    rejectPark(new Error('database unavailable'));
    await expect(promise).resolves.toEqual({
      behavior: 'deny',
      message: 'Stopped by user.',
    });
    expect(pendingToolApprovals.has('tu-hold')).toBe(false);
  });

  it('lets the tRPC caller retry an answer after parking loses on persistence', async () => {
    vi.useFakeTimers();
    let rejectPark!: (error: Error) => void;
    parkAndKill.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPark = reject;
        }),
    );
    const promise = hold();
    const { claudeRouter } = await import('../trpc/routers/claude');
    const caller = claudeRouter.createCaller({ getWindow: () => null });

    await vi.advanceTimersByTimeAsync(PERMISSION_PROMPT_TIMEOUT_MS);
    await expect(
      caller.respondToolApproval({ toolUseId: 'tu-hold', approved: true }),
    ).resolves.toEqual({ ok: false });
    expect(pendingToolApprovals.has('tu-hold')).toBe(true);

    rejectPark(new Error('database unavailable'));
    await vi.waitFor(() => {
      expect(
        chunks.filter((chunk) => (chunk as { type?: string }).type === 'ask-user-question'),
      ).toHaveLength(2);
    });
    await expect(
      caller.respondToolApproval({
        toolUseId: 'tu-hold',
        approved: true,
        updatedInput: { answers: { question: 'Yes' } },
      }),
    ).resolves.toEqual({ ok: true });
    await expect(promise).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { answers: { question: 'Yes' } },
    });
  });

  it('surfaces cleanup failure after the durable park without restoring the native card', async () => {
    vi.useFakeTimers();
    parkAndKill.mockImplementationOnce(async (_signal, onPersisted) => {
      onPersisted();
      throw new Error('provider did not settle');
    });
    void hold();

    await vi.advanceTimersByTimeAsync(PERMISSION_PROMPT_TIMEOUT_MS);
    expect(pendingToolApprovals.has('tu-hold')).toBe(false);
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: 'error',
        errorText: expect.stringContaining('slot remains occupied'),
      }),
    );
  });

  // Multi-pane: two chats can have a question outstanding at once. They share the
  // pendingToolApprovals map (keyed by toolUseId), so answering one must not affect the other.
  it('resolves two concurrent questions (multi-pane) independently with no cross-talk', async () => {
    const pA = hold('tu-paneA', 'pane-A');
    const pB = hold('tu-paneB', 'pane-B');

    // Answer A, stop B — opposite outcomes on the shared map at the same time.
    pendingToolApprovals.get('tu-paneA')?.resolve({
      approved: true,
      updatedInput: { questions: [], answers: { q: 'A-pick' } },
    });
    pendingToolApprovals.get('tu-paneB')?.resolve({ approved: false, message: 'Skipped' });

    await expect(pA).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { questions: [], answers: { q: 'A-pick' } },
    });
    await expect(pB).resolves.toEqual({ behavior: 'deny', message: 'Skipped' });
  });
});

describe('ask-user-question-approval', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    pendingToolApprovals.clear();
  });

  it('clearPendingApprovals resolves pending with denied for matching subChat', () => {
    let resolved: unknown;
    pendingToolApprovals.set('tid-1', {
      subChatId: 'sub-1',
      resolve: (d) => {
        resolved = d;
      },
    });
    clearPendingApprovals('gone', 'sub-1');
    expect(resolved).toEqual({ approved: false, message: 'gone' });
    expect(pendingToolApprovals.size).toBe(0);
  });

  it('clearPendingApprovals skips other subChats when subChatId is passed', () => {
    pendingToolApprovals.set('tid-a', {
      subChatId: 'sub-other',
      resolve: vi.fn(),
    });
    clearPendingApprovals('gone', 'sub-1');
    expect(pendingToolApprovals.has('tid-a')).toBe(true);
  });

  it('clearPendingApprovals without subChatId clears all pending entries', () => {
    const r1 = vi.fn();
    const r2 = vi.fn();
    pendingToolApprovals.set('a', { subChatId: 's1', resolve: r1 });
    pendingToolApprovals.set('b', { subChatId: 's2', resolve: r2 });
    clearPendingApprovals('Session ended.');
    expect(r1).toHaveBeenCalledWith({ approved: false, message: 'Session ended.' });
    expect(r2).toHaveBeenCalledWith({ approved: false, message: 'Session ended.' });
    expect(pendingToolApprovals.size).toBe(0);
  });

  it('clearPendingApprovals leaves an entry whose competing transition already won', () => {
    const resolve = vi.fn(() => false);
    pendingToolApprovals.set('parking', { subChatId: 's1', resolve });

    clearPendingApprovals('Execution ended.', 's1');

    expect(resolve).toHaveBeenCalledOnce();
    expect(pendingToolApprovals.has('parking')).toBe(true);
  });
});
