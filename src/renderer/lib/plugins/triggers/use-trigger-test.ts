import { useCallback, useRef, useState } from 'react';

/**
 * The test procedure: one real vendor-shaped sample sent down the same path a real delivery takes,
 * so any Flow listening for the event actually runs.
 */
export type SendTriggerTest = (input: {
  integrationId: string;
  endpointId: string;
  eventId: string;
}) => Promise<{ success: true } | { success: false; error?: string }>;

/** The cloud's reason, when it gave one, follows the plain sentence. */
function failedToSend(label: string, reason?: string): string {
  return `Frink could not send a test ${label} event${reason ? `: ${reason}` : '.'}`;
}

/** Sends a test event and reports the outcome in the words the card shows. */
export function useTriggerTest(send: SendTriggerTest) {
  const [message, setMessage] = useState('');
  const [isSending, setIsSending] = useState(false);
  const newest = useRef(0);

  const sendTest = useCallback(
    async (input: {
      integrationId: string;
      endpointId: string;
      event: { id: string; label: string };
    }) => {
      const ticket = (newest.current += 1);
      setIsSending(true);
      setMessage('');
      let text: string;
      try {
        const result = await send({
          integrationId: input.integrationId,
          endpointId: input.endpointId,
          eventId: input.event.id,
        });
        text = result.success
          ? `Sample “${input.event.label}” sent. Matching Flows will run.`
          : failedToSend(input.event.label, result.error);
      } catch {
        text = failedToSend(input.event.label);
      }
      // Only the newest test reports, so a slower earlier send cannot overwrite it.
      if (newest.current !== ticket) return;
      setMessage(text);
      setIsSending(false);
    },
    [send],
  );

  return { message, isSending, sendTest };
}
