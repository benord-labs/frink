import type { MobileOverview } from '../../../../src/shared/types/remote/mobile';

export type QueueFilter = 'all' | 'attention' | 'running';
export type Decision = {
  key: string;
  target?: { type: 'question' | 'permission'; id: string };
  title: string;
  sourceTitle: string;
  context: string;
  description: string;
  status: string;
  action: string;
  chatId?: string | null;
  subChatId?: string | null;
  flowRunId?: string | null;
};

function collectDecisions(data: MobileOverview): Decision[] {
  const questions: Decision[] = data.questions.map((item) => ({
    key: `question:${item.id}`,
    target: { type: 'question', id: item.id },
    title: item.questions[0]?.question ?? item.title,
    sourceTitle: item.title,
    context: item.title,
    description: '',
    status: 'awaiting_input',
    action: 'Answer in chat',
    chatId: item.chatId,
    subChatId: item.subChatId,
  }));
  const permissions: Decision[] = data.permissions.map((item) => ({
    key: `permission:${item.requestId}`,
    target: { type: 'permission', id: item.requestId },
    title: item.title,
    sourceTitle: item.title,
    context: '',
    description: item.description,
    status: 'awaiting_input',
    action: 'Review request',
    chatId: item.chatId,
    subChatId: item.subChatId,
  }));
  const specific = [...questions, ...permissions];
  const remaining: Decision[] = data.queue
    .filter((item) => item.section === 'attention')
    .filter(
      (item) =>
        !specific.some(
          (decision) =>
            item.chatId === decision.chatId &&
            item.subChatId === decision.subChatId &&
            (item.title === decision.sourceTitle || item.title === decision.title),
        ),
    )
    .map((item) => ({
      key: item.id,
      title: item.title,
      sourceTitle: item.title,
      context: item.summary,
      description: '',
      status: item.status,
      action: 'Review work',
      chatId: item.chatId,
      subChatId: item.subChatId,
      flowRunId: item.flowRunId,
    }));
  return [...specific, ...remaining];
}

/** Everything that needs the user's decision; the same set the Queue tab badge counts. */
export function needsYouCount(data: MobileOverview | undefined): number {
  return data ? collectDecisions(data).length : 0;
}

function matches(needle: string, ...fields: string[]) {
  return fields.join(' ').toLocaleLowerCase().includes(needle);
}

/** What the queue shows for a search and filter; a search never shows an empty "caught up" card. */
export function queueView(data: MobileOverview | undefined, query: string, filter: QueueFilter) {
  const needle = query.trim().toLocaleLowerCase();
  const decisions = (data ? collectDecisions(data) : []).filter((item) =>
    matches(needle, item.title, item.context, item.description),
  );
  const items = (data?.queue ?? []).filter((item) => matches(needle, item.title, item.summary));
  const running = items.filter((item) => item.section === 'running');
  const inbox = items.filter((item) => item.section === 'inbox');
  const showAttention = filter !== 'running' && (!needle || decisions.length > 0);
  const showRunning = filter !== 'attention' && (!needle || running.length > 0);
  const showInbox = filter === 'all' && inbox.length > 0;
  const visible =
    (filter !== 'running' ? decisions.length : 0) +
    (filter !== 'attention' ? running.length : 0) +
    (showInbox ? inbox.length : 0);
  return {
    decisions,
    running,
    inbox,
    showAttention,
    showRunning,
    showInbox,
    noMatches: !!needle && !visible,
  };
}
