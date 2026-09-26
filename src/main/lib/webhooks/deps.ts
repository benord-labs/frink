import type { WebhookReceiverDeps } from '../../../shared/webhooks/receiver';
import type { getDatabase } from '../db';
import {
  captureNotionChallengeSecret,
  findActiveWebhookEndpoint,
  listActiveWebhookEndpoints,
  markWebhookEndpointError,
  markWebhookEndpointReceived,
} from '../db/repos/webhook-ingress';

type Db = ReturnType<typeof getDatabase>;
type ForwardedWebhookEvent = Parameters<WebhookReceiverDeps['forwardWebhookEvent']>[0];

/** The machine-side calls this module deliberately does not import: the keyring, the flow engine
 * and Sentry are all wired in at boot so the receiver stays testable without them. */
export type LocalWebhookIo = {
  db: Db;
  encryptSecret(plaintext: string): string;
  decryptSecret(ciphertext: string): string | null;
  forwardEvent(event: ForwardedWebhookEvent): Promise<void>;
  captureException(cause: unknown, tags?: Record<string, string>): void;
};

/** The two refusals the receiver words itself. Any other message can quote an extractor's view of
 * the payload, which must not reach local SQLite or a log the owner pastes into a bug report. */
const RECEIVER_ERROR_MARKS = new Set([
  'Missing required webhook signature',
  'Invalid webhook signature - secret mismatch',
]);
const OPAQUE_ERROR = 'Could not process this delivery';
const UNREADABLE_SECRET = 'The saved secret for this address cannot be read on this machine';

/** The keyring refuses ciphertext it did not seal, by throwing. Such a row is unreadable rather
 * than a delivery anyone can fix, so it is recorded and then answered as no endpoint at all. */
export function readSealedSecret(io: LocalWebhookIo, ciphertext: string): string | null {
  try {
    return io.decryptSecret(ciphertext);
  } catch {
    return null;
  }
}

/** The subscribe key of every active address, decrypted. A key this machine cannot read claims
 * nothing, and its endpoint says so on the first delivery it is sent. */
export async function listSubscribeKeys(io: LocalWebhookIo): Promise<string[]> {
  const rows = await listActiveWebhookEndpoints(io.db);
  return rows.flatMap((row) => {
    const key = readSealedSecret(io, row.subscribeKeyEncrypted);
    return key ? [key] : [];
  });
}

export function createLocalWebhookDeps(io: LocalWebhookIo): WebhookReceiverDeps {
  return {
    async getWebhookEndpointByPathToken(pathToken, provider) {
      const row = await findActiveWebhookEndpoint(io.db, pathToken, provider);
      if (!row) return null;
      const secret = readSealedSecret(io, row.endpoint.signingSecretEncrypted);
      if (!secret) {
        await markWebhookEndpointError(io.db, row.endpoint.id, UNREADABLE_SECRET);
        return null;
      }
      return {
        integration: { id: row.integration.id, external_user_id: row.integration.externalUserId },
        endpoint: {
          id: row.endpoint.id,
          webhook_path_token: row.endpoint.pathToken,
          webhook_secret: secret,
          vendor_ref: row.endpoint.vendorRef,
        },
      };
    },
    markIntegrationWebhookError: (endpointId, errorMessage, expected) =>
      markWebhookEndpointError(
        io.db,
        endpointId,
        RECEIVER_ERROR_MARKS.has(errorMessage) ? errorMessage : OPAQUE_ERROR,
        expected,
      ),
    markIntegrationWebhookReceived: (endpointId, expected, recordReceipt) =>
      markWebhookEndpointReceived(io.db, endpointId, expected, recordReceipt),
    forwardWebhookEvent: (event) => io.forwardEvent(event),
    captureNotionChallenge: (endpointId, generation, token) =>
      captureNotionChallengeSecret(io.db, endpointId, generation, io.encryptSecret(token)),
    captureException: (cause, tags) => io.captureException(cause, tags),
  };
}
