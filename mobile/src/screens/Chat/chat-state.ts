import type {
  MobileActivity,
  MobileChatDetail,
} from '../../../../src/shared/types/remote/mobile';

/**
 * What the composer's trailing button does right now.
 * - `send` starts a turn; `steer` joins the running one at its next step;
 * - `stop` ends the running turn (empty input) or background work (sending is impossible then);
 * - `unavailable` means the Mac can't run chats, so nothing can be sent.
 */
export type ComposerMode = 'send' | 'steer' | 'stop' | 'unavailable';

export function composerMode(
  activity: MobileActivity,
  hasText: boolean,
  executionReady: boolean,
): ComposerMode {
  if (activity === 'running') return hasText ? 'steer' : 'stop';
  if (activity === 'background') return 'stop';
  return executionReady ? 'send' : 'unavailable';
}

/**
 * Whether the trailing button can be pressed. Stop always can; a steer needs text (it is
 * text-only); a send needs text or files, all uploaded.
 */
export function actionEnabled(
  mode: ComposerMode,
  draft: { text: string; files: number; uploading: boolean; failed: boolean },
): boolean {
  if (mode === 'stop') return true;
  if (mode === 'steer') return !!draft.text.trim();
  if (mode === 'unavailable' || draft.uploading || draft.failed) return false;
  return !!draft.text.trim() || draft.files > 0;
}

export function composerPlaceholder(activity: MobileActivity, executionReady: boolean): string {
  if (activity === 'running') return 'Guide Frink while it works';
  if (activity === 'background') return 'Frink is waiting on background work';
  return executionReady ? 'Message Frink' : 'Open Frink on your Mac to chat';
}

export const STEER_NOT_DELIVERED = 'Frink can’t take this mid-step. It’s kept for when it finishes.';

/** Busy chats refresh quickly so steps and Stop feel live; idle ones settle down. */
export function chatPollInterval(activity: MobileActivity | undefined): number {
  return activity === 'running' || activity === 'background' ? 2000 : 4000;
}

export function decisionStillOpen(
  data: MobileChatDetail | undefined,
  target: { type: 'question' | 'permission'; id: string } | undefined,
): boolean {
  if (!data || !target) return false;
  return target.type === 'question'
    ? data.questions.some((question) => question.id === target.id)
    : data.permissions.some((permission) => permission.requestId === target.id);
}

/** An open question or permission replaces the idle composer: answering it is the next step. */
export function showsComposer(data: MobileChatDetail): boolean {
  return data.activity !== 'idle' || (!data.questions.length && !data.permissions.length);
}
