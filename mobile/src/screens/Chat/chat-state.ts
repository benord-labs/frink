import type { MobileActivity, MobileChatDetail } from '@frink/shared/types/remote/mobile';

/**
 * What the composer's trailing button does right now.
 * - `send` starts a turn, or takes over a background wait as a desktop send does;
 * - `steer` joins the running turn at its next step;
 * - `stop` ends the running turn, or background work that can't take a message right now;
 * - `unavailable` means the Mac can't run chats, so nothing can be sent.
 */
export type ComposerMode = 'send' | 'steer' | 'stop' | 'unavailable';

/**
 * Whether a new message can start a turn: when idle, or by taking over a chat's background wait.
 * A Flow step's wait belongs to its run, so the Mac refuses messages there until the step ends.
 */
export function acceptsMessage(
  activity: MobileActivity,
  executionReady: boolean,
  flowRun: boolean,
): boolean {
  return executionReady && (activity === 'idle' || (activity === 'background' && !flowRun));
}

export function composerMode(
  activity: MobileActivity,
  draft: { text: string; files: number },
  executionReady: boolean,
  flowRun: boolean,
): ComposerMode {
  const hasText = !!draft.text.trim();
  if (activity === 'running') return hasText ? 'steer' : 'stop';
  if (activity === 'background')
    return acceptsMessage(activity, executionReady, flowRun) && (hasText || draft.files > 0)
      ? 'send'
      : 'stop';
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

export function composerPlaceholder(
  activity: MobileActivity,
  executionReady: boolean,
  flowRun: boolean,
): string {
  if (activity === 'running') return 'Guide Frink while it works';
  if (activity === 'background')
    return acceptsMessage(activity, executionReady, flowRun)
      ? 'Message Frink while it waits'
      : 'Frink is waiting on background work';
  return executionReady ? 'Message Frink' : 'Open Frink on your Mac to chat';
}

export const STEER_NOT_DELIVERED =
  'Frink can’t take this mid-step. It’s kept for when it finishes.';

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

/** An open question, permission or plan replaces the idle composer: deciding is the next step. */
export function showsComposer(data: MobileChatDetail): boolean {
  return (
    data.activity !== 'idle' ||
    (!data.questions.length && !data.permissions.length && !data.pendingPlanId)
  );
}
