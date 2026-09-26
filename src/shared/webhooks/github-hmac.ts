import crypto from 'node:crypto';

export type GithubWebhookEventType = 'pull_request' | 'issues' | 'issue_comment';

export type GithubWebhookPayload = {
  action?: string;
  repository?: { id?: number };
  pull_request?: { id?: number };
  issue?: { id?: number };
  comment?: { id?: number };
};

export function buildGithubSignature(secret: string, rawBody: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

export function verifyGithubSignatureHeader(
  signatureHeader: string | null | undefined,
  secret: string,
  rawBody: string,
): boolean {
  if (!signatureHeader?.startsWith('sha256=')) {
    return false;
  }
  const expected = buildGithubSignature(secret, rawBody);
  try {
    return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
  } catch {
    return false;
  }
}

export function getGithubEventType(
  headerValue: string | null | undefined,
): GithubWebhookEventType | null {
  if (headerValue === 'pull_request') return 'pull_request';
  if (headerValue === 'issues') return 'issues';
  if (headerValue === 'issue_comment') return 'issue_comment';
  return null;
}

export function buildGithubSourceId(
  deliveryId: string | null | undefined,
  eventHeader: string | null | undefined,
  payload: GithubWebhookPayload,
): string {
  if (deliveryId && deliveryId.trim().length > 0) {
    return deliveryId.trim();
  }
  return [
    eventHeader ?? 'unknown',
    payload.action ?? 'unknown',
    payload.pull_request?.id ??
      payload.issue?.id ??
      payload.comment?.id ??
      payload.repository?.id ??
      '0',
  ].join(':');
}
