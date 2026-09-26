import { describe, expect, it } from 'vitest';
import {
  buildGithubSignature,
  buildGithubSourceId,
  getGithubEventType,
  verifyGithubSignatureHeader,
} from './github-hmac';

describe('github-hmac utils', () => {
  it('verifies valid signatures', () => {
    const body = JSON.stringify({ hello: 'world' });
    const secret = 'test-secret';
    const signature = buildGithubSignature(secret, body);

    expect(verifyGithubSignatureHeader(signature, secret, body)).toBe(true);
    expect(verifyGithubSignatureHeader(signature, `${secret}-wrong`, body)).toBe(false);
    expect(verifyGithubSignatureHeader(null, secret, body)).toBe(false);
  });

  it('returns supported event type only', () => {
    expect(getGithubEventType('pull_request')).toBe('pull_request');
    expect(getGithubEventType('issues')).toBe('issues');
    expect(getGithubEventType('issue_comment')).toBe('issue_comment');
    expect(getGithubEventType('push')).toBeNull();
  });

  it('prefers delivery id for dedup source id', () => {
    const payload = { action: 'opened', pull_request: { id: 123 } };
    expect(buildGithubSourceId('abc-123', 'pull_request', payload)).toBe('abc-123');
    expect(buildGithubSourceId('', 'pull_request', payload)).toBe('pull_request:opened:123');
  });
});
