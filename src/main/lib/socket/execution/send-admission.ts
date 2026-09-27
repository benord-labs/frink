import { Mutex } from 'async-mutex';
import { getActiveExecution } from '../streaming/execution-registry';
import { getLiveStreamSeed } from '../streaming/live-stream';

const admissions = new Map<string, Mutex>();

export class ChatBusyError extends Error {
  constructor() {
    super('This chat is already running. Wait for it to finish or stop it first.');
  }
}

export class DuplicateMessageError extends Error {
  constructor() {
    super('This message is already saved. Check the chat before sending again.');
  }
}

/** Serializes persistence through executor registration, without taking the transcript mutex. */
export async function withMessageAdmission(
  subChatId: string,
  rejectIfBusy: boolean,
  dispatch: (started: (error?: Error) => void) => Promise<void>,
  alreadyPersisted?: () => Promise<boolean>,
): Promise<void> {
  let mutex = admissions.get(subChatId);
  if (!mutex) {
    mutex = new Mutex();
    admissions.set(subChatId, mutex);
  }
  try {
    await mutex.runExclusive(async () => {
      // A persisted user message does not prove executor admission succeeded.
      if (await alreadyPersisted?.()) throw new DuplicateMessageError();
      if (
        rejectIfBusy &&
        (getActiveExecution(subChatId) ||
          getLiveStreamSeed(subChatId).streams.some((stream) => stream.status === 'held'))
      )
        throw new ChatBusyError();
      let acknowledge!: (error?: Error) => void;
      const claimed = new Promise<void>((resolve, reject) => {
        let acknowledged = false;
        acknowledge = (error) => {
          if (acknowledged) return;
          acknowledged = true;
          if (error) reject(error);
          else resolve();
        };
      });
      // Attach a rejection handler before dispatch can reject its acknowledgement synchronously.
      await Promise.all([dispatch(acknowledge), claimed]);
    });
  } finally {
    if (!mutex.isLocked() && admissions.get(subChatId) === mutex) admissions.delete(subChatId);
  }
}
