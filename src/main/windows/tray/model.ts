import type { TrayTarget } from '../../../shared/types/tray';

export type { TrayTarget };

/** A command the menu can answer itself: short and on one line, so the user reads all of it. */
export type TrayApproval = {
  chatId: string;
  subChatId: string;
  requestId: string;
  command: string;
};
export type TrayRow = {
  key: string;
  title: string;
  detail: string;
  target: TrayTarget;
  approval?: TrayApproval;
};
export type TrayModel = { needs: TrayRow[]; working: TrayRow[]; done: TrayRow[] };
type SubChat = { chatId: string; subChatId: string };

/** In-memory state, cheap enough to read every few seconds. */
export type TrayLive = {
  /** `command` is set for a plain shell command; any other request is reviewed in Frink. */
  permissions: Array<SubChat & { requestId: string; command?: string }>;
  questions: SubChat[];
  /** Sub-chats responding (and what they are doing) or waiting on background work (`held`). */
  working: Array<SubChat & { held: boolean; activity: string }>;
  /** The app window is loaded, so an approved command can carry on. */
  canApprove: boolean;
};

/** Database state, read when something changes rather than on every tick. */
export type TraySaved = {
  /** Chat names by id; null for a chat that is archived or gone. */
  names: Map<string, string | null>;
  /** Chats (or `task:<id>` keys) waiting on a plan review or input, from the Work Queue. */
  waits: Array<{ key: string; kind: 'plan' | 'attention' }>;
  approvals: Array<{ flowRunId: string; flowName: string; message: string | null }>;
};

export type TrayCompletion = SubChat & { at: number };

const HOUR_MS = 3_600_000;
const MAX_DONE = 3;
const MAX_INLINE_COMMAND = 60;
const WORK_QUEUE: TrayTarget = { view: 'workqueue' };

export const EMPTY_SAVED: TraySaved = { names: new Map(), waits: [], approvals: [] };

/** Only a short one-line command is answered from the menu; anything else is reviewed in Frink. */
export function isInlineCommand(command: string): boolean {
  const text = command.trim();
  return text.length > 0 && text.length <= MAX_INLINE_COMMAND && !/[\r\n]/.test(text);
}

/** Every chat id the model would show, so the caller can look up names it has not seen. */
export function chatIdsIn(live: TrayLive, completions: TrayCompletion[]): string[] {
  const items = [...live.permissions, ...live.questions, ...live.working, ...completions];
  return items.map((item) => item.chatId);
}

function permissionRow(
  { chatId, subChatId, requestId, command }: TrayLive['permissions'][number],
  canApprove: boolean,
): Omit<TrayRow, 'title'> {
  const inline = command && isInlineCommand(command) ? command.trim() : null;
  const target = { chatId, subChatId };
  const detail = inline ? 'Wants to run a command' : 'Wants your permission';
  const row = { key: `permission:${requestId}`, detail, target };
  return inline && canApprove
    ? { ...row, approval: { ...target, requestId, command: inline } }
    : row;
}

function needsRows(live: TrayLive, saved: TraySaved, name: (chatId: string) => string | null) {
  const rows = new Map<string, TrayRow>();
  const add = (chatId: string, row: Omit<TrayRow, 'title'>, title = name(chatId)) => {
    if (title && !rows.has(chatId)) rows.set(chatId, { ...row, title });
  };
  for (const permission of live.permissions)
    add(permission.chatId, permissionRow(permission, live.canApprove));
  for (const { chatId, subChatId } of live.questions)
    add(chatId, {
      key: `question:${subChatId}`,
      detail: 'Asked you a question',
      target: { chatId, subChatId },
    });
  for (const { key, kind } of saved.waits) {
    const detail = kind === 'plan' ? 'Has a plan for you to review' : 'Needs your input';
    if (!key.startsWith('task:')) add(key, { key: `wait:${key}`, detail, target: { chatId: key } });
    else add(key, { key, detail, target: WORK_QUEUE }, name(key) || 'A task in the Work Queue');
  }
  const approvals = saved.approvals.map(({ flowRunId, flowName, message }) => ({
    key: `approval:${flowRunId}`,
    title: flowName,
    detail: message || 'Waiting for your approval',
    target: WORK_QUEUE,
  }));
  return { rows: [...rows.values(), ...approvals], chatIds: new Set(rows.keys()) };
}

function workingRows(live: TrayLive, skip: Set<string>, name: (chatId: string) => string | null) {
  const rows = new Map<string, TrayRow>();
  // Responding sub-chats first, so a chat shows what it is doing over a parked sibling.
  const ordered = [...live.working].sort((a, b) => Number(a.held) - Number(b.held));
  for (const { chatId, subChatId, held, activity } of ordered) {
    const title = name(chatId);
    if (!title || skip.has(chatId) || rows.has(chatId)) continue;
    const detail = held ? 'Waiting on background work' : activity;
    rows.set(chatId, { key: `working:${chatId}`, title, detail, target: { chatId, subChatId } });
  }
  return rows;
}

function doneRows(
  completions: TrayCompletion[],
  skip: Set<string>,
  now: number,
  name: (chatId: string) => string | null,
) {
  const rows = new Map<string, TrayRow>();
  for (const { chatId, subChatId, at } of [...completions].sort((a, b) => b.at - a.at)) {
    if (now - at > HOUR_MS || rows.size >= MAX_DONE) break;
    const title = name(chatId);
    if (!title || skip.has(chatId) || rows.has(chatId)) continue;
    const minutes = Math.floor((now - at) / 60_000);
    const detail = minutes < 1 ? 'Finished just now' : `Finished ${minutes} min ago`;
    rows.set(chatId, { key: `done:${chatId}`, title, detail, target: { chatId, subChatId } });
  }
  return [...rows.values()];
}

/** What the menu shows: needs you first, then working, then the last hour's finished chats. */
export function buildTrayModel(
  live: TrayLive,
  saved: TraySaved,
  completions: TrayCompletion[],
  now: number,
): TrayModel {
  const name = (chatId: string) => saved.names.get(chatId) ?? null;
  const needs = needsRows(live, saved, name);
  const working = workingRows(live, needs.chatIds, name);
  const shown = new Set([...needs.chatIds, ...working.keys()]);
  const done = doneRows(completions, shown, now, name);
  return { needs: needs.rows, working: [...working.values()], done };
}
