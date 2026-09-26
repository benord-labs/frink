import { describe, expect, it } from 'vitest';
import { classifyApiErrorText, extractTrailingApiError } from './api-error';

/** The exact text that ended flow run ms0qlgm13c8kekvr inside a NORMAL SDK result frame. */
const REVOKED_TOKEN_TEXT =
  'Failed to authenticate. API Error: 401 OAuth access token has been revoked.';

describe('classifyApiErrorText — auth vs transient vs terminal API errors', () => {
  it('classifies the CLI 401 shape (SDK-wrapped) as auth', () => {
    const text =
      'Claude Code returned an error result: Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"},"request_id":"req_x"}';
    expect(classifyApiErrorText(text)).toEqual({ status: 401, kind: 'auth' });
  });

  it('classifies "Failed to authenticate" without a status code as auth (defaults 401)', () => {
    expect(classifyApiErrorText('Failed to authenticate.')).toEqual({ status: 401, kind: 'auth' });
  });

  it.each([429, 500, 502, 503, 529])('classifies API Error: %i as transient', (status) => {
    expect(classifyApiErrorText(`API Error: ${status} {"type":"error"}`)).toEqual({
      status,
      kind: 'transient',
    });
  });

  it('classifies rate_limit_error / overloaded_error bodies as transient when the CLI prefix anchors them', () => {
    expect(classifyApiErrorText('API Error: {"error":{"type":"overloaded_error"}}')).toEqual({
      status: null,
      kind: 'transient',
    });
    expect(classifyApiErrorText('API Error: {"error":{"type":"rate_limit_error"}}')).toEqual({
      status: null,
      kind: 'transient',
    });
  });

  it('does NOT classify a bare JSON body with no CLI prefix (agent output can be JSON)', () => {
    // An agent whose own message is `{"error":{"type":"rate_limit_error"}}` (quoting docs, writing
    // a test) must not trip an API-error retry — only the CLI's own prefixed shape anchors.
    expect(classifyApiErrorText('{"error":{"type":"rate_limit_error"}}')).toBeNull();
    expect(classifyApiErrorText('{"error":{"type":"overloaded_error"}}')).toBeNull();
  });

  it.each([400, 403, 404])('does not classify terminal 4xx (%i)', (status) => {
    expect(
      classifyApiErrorText(`API Error: ${status} {"error":{"type":"invalid_request_error"}}`),
    ).toBeNull();
  });

  it('does not classify plain non-API errors', () => {
    expect(classifyApiErrorText('claude stream exploded')).toBeNull();
    expect(classifyApiErrorText('Command failed: exited with code 1')).toBeNull();
  });

  it('excludes usage-limit texts — they have their own park path', () => {
    expect(
      classifyApiErrorText("You've hit your limit · resets 2:20pm (Europe/London)"),
    ).toBeNull();
  });

  it('does NOT classify an agent message that merely QUOTES an API error mid-text', () => {
    // The SDK's error-result text can be the agent's own final message. An agent working on
    // (or reporting about) auth bugs must not trigger a credential re-resolve + retry.
    expect(
      classifyApiErrorText(
        'I investigated the failure. The chat previously died with "Failed to authenticate. API Error: 401" but the root cause is an expired token that frink never refreshes.',
      ),
    ).toBeNull();
    expect(
      classifyApiErrorText('Note: rate_limit_error handling lives in api-error.ts.'),
    ).toBeNull();
  });

  it('does NOT classify long texts — real CLI API-error results are one-liners plus a JSON body', () => {
    const long = `Failed to authenticate. API Error: 401 ${'x'.repeat(700)}`;
    expect(classifyApiErrorText(long)).toBeNull();
  });

  it('still classifies the anchored shapes with the SDK wrapper prefix', () => {
    expect(
      classifyApiErrorText(
        'Claude Code returned an error result: API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}',
      ),
    ).toEqual({ status: 529, kind: 'transient' });
  });
});

describe('extractTrailingApiError — clean-stream park decision', () => {
  it('detects the revoked-token turn that left a flow run reading "running"', () => {
    expect(extractTrailingApiError([{ type: 'text', text: REVOKED_TOKEN_TEXT }])).toEqual({
      status: 401,
      message: REVOKED_TOKEN_TEXT,
    });
  });

  it('detects the same text through the SDK wrapper, reporting the text as received', () => {
    const wrapped = `Claude Code returned an error result: ${REVOKED_TOKEN_TEXT}`;
    expect(extractTrailingApiError([{ type: 'text', text: wrapped }])).toEqual({
      status: 401,
      message: wrapped,
    });
  });

  it.each([400, 403, 404])(
    'parks on terminal %i even though the retry classifier ignores it',
    (status) => {
      const text = `API Error: ${status} {"error":{"type":"invalid_request_error"}}`;
      // The divergence is deliberate: no retry can save these, which is exactly why the flow
      // must stop rather than read as running.
      expect(classifyApiErrorText(text)).toBeNull();
      expect(extractTrailingApiError([{ type: 'text', text }])).toEqual({ status, message: text });
    },
  );

  it('ignores an API error the turn recovered from', () => {
    expect(
      extractTrailingApiError([
        { type: 'text', text: REVOKED_TOKEN_TEXT },
        { type: 'text', text: 'Retried with a fresh token and finished the migration.' },
      ]),
    ).toBeNull();
  });

  it('skips trailing step-start / reasoning parts to find the real final text', () => {
    expect(
      extractTrailingApiError([
        { type: 'text', text: REVOKED_TOKEN_TEXT },
        { type: 'reasoning' },
        { type: 'step-start' },
      ]),
    ).toEqual({ status: 401, message: REVOKED_TOKEN_TEXT });
  });

  it('ignores a turn whose final part is a tool call rather than text', () => {
    expect(
      extractTrailingApiError([{ type: 'text', text: REVOKED_TOKEN_TEXT }, { type: 'tool-Bash' }]),
    ).toBeNull();
  });

  it('ignores an agent quoting an API error mid-sentence, and over-long texts', () => {
    expect(
      extractTrailingApiError([
        {
          type: 'text',
          text: `I traced it: the turn died with "${REVOKED_TOKEN_TEXT}" so the flow never parked.`,
        },
      ]),
    ).toBeNull();
    expect(
      extractTrailingApiError([{ type: 'text', text: `${REVOKED_TOKEN_TEXT}${'x'.repeat(700)}` }]),
    ).toBeNull();
  });

  it('leaves usage limits to their own park path, and no-ops on empty parts', () => {
    expect(
      extractTrailingApiError([
        { type: 'text', text: "You've hit your limit · resets 2:20pm (Europe/London)" },
      ]),
    ).toBeNull();
    expect(extractTrailingApiError([])).toBeNull();
  });
});
