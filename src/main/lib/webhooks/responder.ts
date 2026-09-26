import type { ServerResponse } from 'node:http';
import type { receiveWebhook } from '../../../shared/webhooks/receiver';

type WebhookResponder = Parameters<typeof receiveWebhook>[1];

/** Writes the receiver's verdict out as a real HTTP response. */
export function httpResponder(res: ServerResponse): WebhookResponder {
  return {
    status: (code) => ({
      json: (body) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      },
    }),
  };
}

type ReceiverBody = Parameters<ReturnType<WebhookResponder['status']>['json']>[0];

export type RecordingResponder = WebhookResponder & {
  verdict(): number | null;
  body(): ReceiverBody | null;
};

/** Keeps the receiver's answer for a delivery nobody is waiting on down the wire: the relay replies
 * to the vendor before this machine has judged anything, and a test event has no sender at all. */
export function recordingResponder(): RecordingResponder {
  let verdict: number | null = null;
  let answer: ReceiverBody | null = null;
  return {
    status: (code) => ({
      json: (payload) => {
        verdict = code;
        answer = payload;
      },
    }),
    verdict: () => verdict,
    body: () => answer,
  };
}
