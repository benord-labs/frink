import type {
  MobileChatDetail,
  MobileComposer,
  MobileResponses,
} from '@frink/shared/types/remote/mobile';

/** Fixed clock for every preview, so relative times ("5m") are stable in screenshots. */
export const NOW = Date.parse('2026-09-29T14:30:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

export function composerFixture(): MobileComposer {
  return {
    mode: 'agent',
    debugAvailable: true,
    provider: 'claude',
    account: {
      id: 'acc-1',
      label: 'Work',
      type: 'claude-code',
      isAuthenticated: true,
      isProjectOverride: false,
    },
    projectId: 'project-1',
    accounts: [
      { id: 'acc-1', label: 'Work', type: 'claude-code', isDefault: true, isAuthenticated: true },
      {
        id: 'acc-2',
        label: 'Personal',
        type: 'claude-code',
        isDefault: false,
        isAuthenticated: true,
      },
    ],
    models: [
      {
        id: 'sonnet',
        name: 'Sonnet',
        familyId: 'sonnet',
        contextLabel: '200k context',
        effort: 'medium',
        effortDefault: true,
        contextDefault: true,
      },
      {
        id: 'sonnet-high',
        name: 'Sonnet',
        detail: 'High',
        familyId: 'sonnet',
        contextLabel: '200k context',
        effort: 'high',
        contextDefault: true,
      },
      {
        id: 'opus-4.8',
        name: 'Opus',
        version: '4.8',
        familyId: 'opus-4.8',
        contextLabel: '1M context',
        effort: 'high',
        effortDefault: true,
        contextDefault: true,
      },
    ],
    settings: { modelId: 'sonnet', autoMode: true, codexSpeed: 'standard', thinkingEnabled: true },
    autoUnavailableReason: '',
    codexSpeedCredits: { fast: null, ultrafast: null },
    xhighSupported: true,
    ultraSupported: true,
  };
}

const projects: MobileResponses['projects'] = [
  { id: 'project-1', name: 'frink', lastActiveAt: ago(2) },
  { id: 'project-2', name: 'marketing-site', lastActiveAt: ago(90) },
  { id: 'project-3', name: 'billing-api', lastActiveAt: ago(60 * 26) },
  { id: 'project-4', name: 'design-system', lastActiveAt: ago(60 * 24 * 9) },
];

const chatNames = [
  'Fix flaky checkout tests',
  'Add dark mode to the pricing page',
  'Nightly triage · Label new issues',
  'Refactor the invoice PDF renderer',
  'Why is the build slow on CI?',
  'Write release notes for 0.0.13',
  'Migrate settings to the new schema',
  'Tidy up unused feature flags',
];

/** A realistic chat list: one running, one parked in the background, one Flow step. */
export function chatsPage(limit = 30): MobileResponses['chats'] {
  const all = Array.from({ length: 40 }, (_, index) => {
    const name = chatNames[index % chatNames.length];
    return {
      id: `chat-${index + 1}`,
      name:
        index < chatNames.length ? name : `${name} (${Math.floor(index / chatNames.length) + 1})`,
      projectId: projects[index % projects.length].id,
      projectName: projects[index % projects.length].name,
      lastActiveAt: ago(
        [1, 6, 40, 180, 60 * 20, 60 * 30, 60 * 24 * 3, 60 * 24 * 12][index % 8] + index * 3,
      ),
      activity: index === 0 ? 'running' : index === 1 ? 'background' : 'idle',
      kind: index === 2 ? 'flow' : 'chat',
    } as const;
  });
  return { items: all.slice(0, limit), hasMore: limit < all.length };
}

export function overviewFixture(): MobileResponses['overview'] {
  return {
    machineName: "Benji's MacBook Pro",
    executionReady: true,
    appVersion: '0.0.13',
    queue: [
      {
        id: 'task-plan',
        title: 'Plan the Stripe webhook retry fix',
        summary: 'Plan is ready for your review',
        status: 'plan_ready',
        section: 'attention',
        chatId: 'chat-4',
        subChatId: 'sub-4',
        flowRunId: null,
        projectName: 'billing-api',
        activityAt: ago(12),
        actions: [],
      },
      {
        id: 'task-failed',
        title: 'Nightly triage',
        summary: 'Step 3 of 5 failed: GitHub rate limit',
        status: 'failed',
        section: 'attention',
        chatId: 'chat-3',
        subChatId: 'sub-3',
        flowRunId: 'run-2',
        projectName: 'frink',
        activityAt: ago(35),
        actions: [],
      },
      {
        id: 'task-done',
        title: 'Add dark mode to the pricing page',
        summary: 'Finished with 4 changed files',
        status: 'done',
        section: 'attention',
        chatId: 'chat-2',
        subChatId: 'sub-2',
        flowRunId: null,
        projectName: 'marketing-site',
        activityAt: ago(50),
        actions: ['completeTask'],
      },
      {
        id: 'task-run-chat',
        title: 'Fix flaky checkout tests',
        summary: 'Running the test suite',
        status: 'running',
        section: 'running',
        chatId: 'chat-1',
        subChatId: 'sub-1',
        flowRunId: null,
        projectName: 'frink',
        activityAt: ago(4),
        actions: [],
      },
      {
        id: 'task-run-flow',
        title: 'Weekly dependency update',
        summary: 'Step 2 of 4 · Update packages',
        status: 'running',
        section: 'running',
        chatId: 'chat-9',
        subChatId: 'sub-9',
        flowRunId: 'run-1',
        projectName: 'design-system',
        activityAt: ago(9),
        actions: [],
      },
      {
        id: 'task-inbox',
        title: 'Summarise yesterday’s support emails',
        summary: 'From Gmail · waiting to start',
        status: 'pending',
        section: 'inbox',
        chatId: null,
        subChatId: null,
        flowRunId: null,
        projectName: null,
        activityAt: ago(120),
        actions: ['startTask'],
      },
    ],
    counts: { attention: 3, running: 2, inbox: 1 },
    more: { attention: false, running: false, inbox: false },
    agents: { running: 2, needsYou: 3 },
    questions: [
      {
        id: 'question-1',
        source: 'live',
        chatId: 'chat-5',
        subChatId: 'sub-5',
        title: 'Why is the build slow on CI?',
        questions: [
          {
            question: 'Should I switch the CI cache to the lockfile hash?',
            header: 'CI cache',
            multiSelect: false,
            options: [
              {
                label: 'Yes, switch it',
                description: 'Rebuilds the cache when dependencies change',
              },
              { label: 'Keep the current key', description: 'No change to CI' },
            ],
          },
        ],
      },
    ],
    permissions: [
      {
        requestId: 'perm-1',
        chatId: 'chat-6',
        subChatId: 'sub-6',
        title: 'Run database migration',
        description: 'bun run db:migrate --env staging',
        supported: true,
      },
    ],
  };
}

export function flowsFixture(): MobileResponses['flows'] {
  return [
    {
      id: 'flow-1',
      name: 'Weekly dependency update',
      description: 'Updates packages, runs tests and opens a PR',
      enabled: true,
      trigger: 'schedule_trigger',
      latestRunId: 'run-1',
      status: 'running',
      lastRun: { id: 'run-1', status: 'running', at: ago(9) },
    },
    {
      id: 'flow-2',
      name: 'Nightly triage',
      description: 'Labels and prioritises new GitHub issues',
      enabled: true,
      trigger: 'schedule_trigger',
      latestRunId: 'run-2',
      status: null,
      lastRun: { id: 'run-2', status: 'failed', at: ago(35) },
    },
    {
      id: 'flow-3',
      name: 'Release checklist',
      description: 'Walks a release from changelog to announcement',
      enabled: true,
      trigger: 'manual_trigger',
      latestRunId: 'run-3',
      status: 'awaiting_input',
      lastRun: { id: 'run-3', status: 'awaiting_input', at: ago(15) },
    },
    {
      id: 'flow-4',
      name: 'Support inbox digest',
      description: 'Summarises support email every morning',
      enabled: true,
      trigger: 'webhook_trigger',
      latestRunId: 'run-4',
      status: null,
      lastRun: { id: 'run-4', status: 'completed', at: ago(60 * 7) },
    },
    {
      id: 'flow-5',
      name: 'Screenshot regression check',
      description: 'Compares UI screenshots after every merge',
      enabled: false,
      trigger: 'post_task_trigger',
      latestRunId: null,
      status: null,
      lastRun: null,
    },
  ];
}

export function flowFixture(): MobileResponses['flow'] {
  const flow = flowsFixture()[0];
  return {
    flow,
    runs: {
      items: [
        { id: 'run-1', status: 'running', createdAt: ago(9), startedAt: ago(9), completedAt: null },
        {
          id: 'run-0',
          status: 'completed',
          createdAt: ago(60 * 24 * 7),
          startedAt: ago(60 * 24 * 7),
          completedAt: ago(60 * 24 * 7 - 6),
        },
        {
          id: 'run-00',
          status: 'failed',
          createdAt: ago(60 * 24 * 14),
          startedAt: ago(60 * 24 * 14),
          completedAt: ago(60 * 24 * 14 - 2),
        },
      ],
      hasMore: false,
    },
    definition: {
      versionNumber: 3,
      nodes: [
        {
          id: 'n1',
          label: 'Every Monday at 9:00',
          blockType: 'schedule_trigger',
          parentId: null,
          instructions: null,
        },
        {
          id: 'n2',
          label: 'Update packages',
          blockType: 'agent',
          parentId: null,
          instructions: 'Run bun update and fix breaking changes.',
        },
        {
          id: 'n3',
          label: 'Run tests',
          blockType: 'agent',
          parentId: null,
          instructions: 'Run the full test suite.',
        },
        {
          id: 'n4',
          label: 'Approve the PR',
          blockType: 'approval',
          parentId: null,
          instructions: null,
        },
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2', label: null, sourceHandle: null },
        { id: 'e2', source: 'n2', target: 'n3', label: null, sourceHandle: null },
        { id: 'e3', source: 'n3', target: 'n4', label: null, sourceHandle: null },
      ],
    },
  };
}

export function runFixture(): MobileResponses['run'] {
  return {
    id: 'run-1',
    status: 'running',
    createdAt: ago(9),
    startedAt: ago(9),
    completedAt: null,
    flowId: 'flow-1',
    flowName: 'Weekly dependency update',
    nodes: [
      {
        id: 'nr1',
        label: 'Every Monday at 9:00',
        status: 'completed',
        detail: '',
        chatId: null,
        subChatId: null,
        actions: [],
        actionToken: 'a'.repeat(64),
        startedAt: ago(9),
        completedAt: ago(9),
      },
      {
        id: 'nr2',
        label: 'Update packages',
        status: 'running',
        detail: 'Updating 14 packages',
        chatId: 'chat-9',
        subChatId: 'sub-9',
        actions: [],
        actionToken: 'b'.repeat(64),
        startedAt: ago(8),
        completedAt: null,
      },
      {
        id: 'nr3',
        label: 'Run tests',
        status: 'pending',
        detail: '',
        chatId: null,
        subChatId: null,
        actions: [],
        actionToken: 'c'.repeat(64),
        startedAt: null,
        completedAt: null,
      },
      {
        id: 'nr4',
        label: 'Approve the PR',
        status: 'pending',
        detail: '',
        chatId: null,
        subChatId: null,
        actions: [],
        actionToken: 'd'.repeat(64),
        startedAt: null,
        completedAt: null,
      },
    ],
  };
}

export function chatFixture(activity: MobileChatDetail['activity'] = 'running'): MobileChatDetail {
  return {
    chat: { id: 'chat-1', name: 'Fix flaky checkout tests', projectId: 'project-1' },
    subChatId: 'sub-1',
    subChats: [{ id: 'sub-1', name: 'Fix flaky checkout tests', activity }],
    messages: [
      {
        id: 'm1',
        role: 'user',
        text: 'The checkout tests fail about one run in five on CI. Find out why and fix it.',
        parts: [
          {
            type: 'text',
            text: 'The checkout tests fail about one run in five on CI. Find out why and fix it.',
          },
        ],
      },
      {
        id: 'm2',
        role: 'assistant',
        text: 'I found the cause.',
        parts: [
          { type: 'tool', id: 't1', name: 'Grep', state: 'completed' },
          { type: 'tool', id: 't2', name: 'Read', state: 'completed' },
          { type: 'tool', id: 't3', name: 'Bash', state: 'completed' },
          {
            type: 'text',
            text: 'I found the cause. `checkout.spec.ts` waits for the **Pay** button with a fixed `500ms` timeout, but the payment iframe sometimes takes longer on CI.\n\nI’ll replace the timeout with a wait for the iframe’s `ready` event, then run the suite 20 times to confirm.',
          },
          { type: 'steer', text: 'Use the existing waitForFrame helper instead of a new one.' },
          { type: 'tool', id: 't4', name: 'Edit', state: 'completed' },
          {
            type: 'tool',
            id: 't5',
            name: 'Bash',
            state: activity === 'running' ? 'running' : 'completed',
          },
        ],
      },
    ],
    hasMore: false,
    activity,
    kind: 'chat',
    error: null,
    questions: [],
    permissions: [],
    pendingPlanId: null,
  };
}

/** Everything the computer answers, by request type. Tests override single entries. */
export function previewData(): Partial<Record<keyof MobileResponses, unknown>> {
  return {
    overview: overviewFixture(),
    projects,
    chats: chatsPage(),
    chat: chatFixture(),
    flows: flowsFixture(),
    flow: flowFixture(),
    run: runFixture(),
    composer: composerFixture(),
  };
}
