import type { MobileRequest } from '@frink/shared/types/remote/mobile';
import type { useConnection } from '../connection';
import { ApiError } from '../relay/error';
import {
  STEER_REFUSED,
  changePending,
  markFailed,
  markSending,
  markSent,
  type PendingEntry,
} from './pending';

type AppLifecycle = {
  currentState: string;
  addEventListener: (type: 'change', listener: (state: string) => void) => { remove: () => void };
};
export type DeliverEnv = {
  request: ReturnType<typeof useConnection>['request'];
  /** React Native's AppState: an unreachable send is retried once the app is in front again. */
  app: AppLifecycle;
};
export type Outbox = { key: string; chatId: string; subChatId: string };
type SendRequest = Extract<MobileRequest, { type: 'sendMessage' }>;

function whenActive(app: AppLifecycle): Promise<void> {
  if (app.currentState === 'active') return Promise.resolve();
  return new Promise((resolve) => {
    const subscription = app.addEventListener('change', (state) => {
      if (state !== 'active') return;
      subscription.remove();
      resolve();
    });
  });
}

/** Runs a call, and once more after the app is back in front if the computer was unreachable. */
function retryUnreachable<T>(app: AppLifecycle, call: () => Promise<T>): Promise<T> {
  return call().catch(async (error: Error) => {
    if (!(error instanceof ApiError) || error.status !== 0) throw error;
    await whenActive(app);
    return call();
  });
}

/** A 409 also answers a repeated id, so the transcript decides whether the first copy arrived. */
async function arrived({ request }: DeliverEnv, outbox: Outbox, id: string) {
  try {
    const chat = await request({ type: 'chat', id: outbox.chatId, subChatId: outbox.subChatId });
    return chat.messages.some((message) => message.id === id);
  } catch {
    return false;
  }
}

/** Joins the running turn; the computer answers a repeated id with its first outcome. */
async function steer(env: DeliverEnv, outbox: Outbox, entry: PendingEntry) {
  const { outcome } = await retryUnreachable(env.app, () =>
    env.request({
      type: 'steerMessage',
      chatId: outbox.chatId,
      subChatId: outbox.subChatId,
      requestId: entry.id,
      text: entry.text.trim(),
    }),
  );
  const joined = outcome === 'delivered';
  changePending(outbox.key, (entries) =>
    joined ? markSent(entries, entry.id) : markFailed(entries, entry.id, STEER_REFUSED),
  );
  return joined;
}

function sendRequest(outbox: Outbox, entry: PendingEntry): SendRequest {
  const body: SendRequest = {
    type: 'sendMessage',
    chatId: outbox.chatId,
    subChatId: outbox.subChatId,
    requestId: entry.id,
    text: entry.text,
  };
  if (entry.attachments.length) body.attachments = entry.attachments.map(({ id }) => id);
  return body;
}

/** Sends a new turn; the computer refuses a repeated id rather than posting it twice. */
async function send(env: DeliverEnv, outbox: Outbox, entry: PendingEntry) {
  try {
    await retryUnreachable(env.app, () => env.request(sendRequest(outbox, entry)));
  } catch (error) {
    const duplicate = error instanceof ApiError && error.status === 409;
    if (!duplicate || !(await arrived(env, outbox, entry.id))) throw error;
  }
  changePending(outbox.key, (entries) => markSent(entries, entry.id));
  return true;
}

/**
 * Sends or steers a pending message under its own id, so a repeat is never posted twice.
 * Resolves true once the computer has it; anything else leaves it failed, with the reason.
 */
export async function deliver(env: DeliverEnv, outbox: Outbox, entry: PendingEntry) {
  changePending(outbox.key, (entries) => markSending(entries, entry.id));
  try {
    return await (entry.kind === 'steer' ? steer : send)(env, outbox, entry);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not send the message.';
    changePending(outbox.key, (entries) => markFailed(entries, entry.id, message));
    return false;
  }
}
