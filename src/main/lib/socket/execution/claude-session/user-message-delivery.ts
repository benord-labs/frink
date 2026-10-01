import log from 'electron-log';
import { captureMainException } from '../../../sentry/init';

/** Wire category for a turn that settled without its prompt reaching the CLI (sc-3666). */
export const MESSAGE_NOT_DELIVERED_CATEGORY = 'MESSAGE_NOT_DELIVERED';

/** Tracks whether one run's prompt actually landed on the CLI input queue, across its attempts. */
export function trackUserMessageDelivery(
  subChatId: string,
  assistantMessageId: string,
  promptChars: () => number,
) {
  let pushed = false;
  return {
    /** The `onPushed` callback for one turn registration: an adopted arming, a claimed idle
     * session, or a fresh spawn. */
    onPushed: (adopted: boolean, claimed: boolean) => () => {
      pushed = true;
      const path = adopted ? 'adopted' : claimed ? 'warm' : 'fresh';
      log.info('[Socket Executor] user turn pushed', {
        subChatId,
        assistantMessageId,
        path,
        chars: promptChars(),
      });
    },
    /** An unpushed turn that settled must not read as complete: fail it so the user gets Retry.
     * An aborted run (Stop, superseded) is left to its own disposition. */
    assertDelivered(aborted: boolean, resumed: boolean): void {
      if (pushed || aborted) return;
      const error = Object.assign(new Error('Your message was not delivered to the agent.'), {
        category: MESSAGE_NOT_DELIVERED_CATEGORY,
      });
      captureMainException(error, {
        surface: 'executor',
        stage: 'deliver',
        subChatId,
        resumed: String(resumed),
      });
      throw error;
    },
  };
}
