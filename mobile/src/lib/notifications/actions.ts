import type { MobileRequest, MobileResponses } from '@frink/shared/types/remote/mobile';
import type { NotificationAction } from 'expo-notifications';
import type { Connection } from '../api';
import { ApiError } from '../relay/error';
import type { AlertedComputer } from './routing';

const ALLOW = 'allow';
const DENY = 'deny';
const UNSENT = 'Your answer wasn’t sent';
const UNREACHED = 'Frink couldn’t reach your computer. Answer it in the chat once it’s back.';

/** A permission alert's buttons: each asks for the phone to be unlocked, then opens Frink. */
export const PERMISSION_BUTTONS: NotificationAction[] = [
  {
    identifier: ALLOW,
    buttonTitle: 'Allow',
    options: { opensAppToForeground: true, isAuthenticationRequired: true },
  },
  {
    identifier: DENY,
    buttonTitle: 'Deny',
    options: { opensAppToForeground: true, isAuthenticationRequired: true, isDestructive: true },
  },
];

/** Whether `action` is one of a permission alert's buttons. */
export const isPermissionButton = (action: string) => action === ALLOW || action === DENY;

/** The answer a tapped Allow or Deny gives the one request its alert names; null otherwise. */
export function permissionActionFor(action: string, alert: AlertedComputer) {
  const { target, requestId } = alert;
  if (!isPermissionButton(action) || !requestId || target === 'queue' || !target.subChatId)
    return null;
  return {
    type: 'respondPermission',
    chatId: target.id,
    subChatId: target.subChatId,
    requestId,
    approved: action === ALLOW,
  } satisfies MobileRequest;
}

let lastAnswer: AlertedComputer | null = null;
const answerListeners = new Set<() => void>();

/** The latest alert whose Allow or Deny its computer accepted. */
export const lastAlertAnswer = () => lastAnswer;

/** Calls `listener` each time an alert's answer is accepted; returns the unsubscribe. */
export function onAlertAnswer(listener: () => void) {
  answerListeners.add(listener);
  return () => void answerListeners.delete(listener);
}

type PermissionAnswer = NonNullable<ReturnType<typeof permissionActionFor>>;

/** Sends Allow or Deny only to the computer the alert came from; a failed answer says why. */
export async function answerFromAlert(
  action: string,
  alert: AlertedComputer,
  computers: readonly Connection[],
  send: (
    answer: PermissionAnswer,
    host: Connection,
  ) => Promise<MobileResponses['respondPermission']>,
  say: (title: string, message: string) => void,
) {
  const answer = permissionActionFor(action, alert);
  const host = computers.find((computer) => computer.deviceId === alert.deviceId);
  if (!answer || !host) return;
  try {
    await send(answer, host);
  } catch (error) {
    say(UNSENT, error instanceof ApiError ? error.message : UNREACHED);
    return;
  }
  lastAnswer = alert;
  answerListeners.forEach((listener) => listener());
}

/** Whether an answered alert belongs to this chat on the computer now shown. */
export const answersChat = (
  alert: AlertedComputer | null,
  deviceId: string | undefined,
  chatId: string,
) =>
  !!alert && alert.deviceId === deviceId && alert.target !== 'queue' && alert.target.id === chatId;
