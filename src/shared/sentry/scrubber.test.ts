import { describe, expect, it } from 'vitest';
import { normalizeUserPath, redactString } from './redaction';
import {
  beforeBreadcrumb,
  beforeSend,
  type ScrubbableBreadcrumb,
  type ScrubbableEvent,
} from './scrubber';

describe('redactString', () => {
  it('redacts long opaque tokens', () => {
    const out = redactString('failed: sk-abcdefghijklmnopqrstuvwxyz1234567890');
    expect(out).toBe('failed: [REDACTED]');
  });

  it('leaves short strings alone', () => {
    expect(redactString('short')).toBe('short');
  });
});

describe('normalizeUserPath', () => {
  it('replaces macOS user home', () => {
    expect(normalizeUserPath('/Users/benji/code/foo.ts')).toBe('/home/user/code/foo.ts');
  });

  it('replaces Linux user home', () => {
    expect(normalizeUserPath('/home/jane/work/bar.ts')).toBe('/home/user/work/bar.ts');
  });

  it('replaces Windows user home', () => {
    expect(normalizeUserPath('C:\\Users\\Bob\\App\\baz.ts')).toBe('/home/user\\App\\baz.ts');
  });
});

describe('beforeSend', () => {
  it('drops events whose stack touches sensitive paths', () => {
    const event: ScrubbableEvent = {
      exception: {
        values: [
          {
            value: 'boom',
            stacktrace: { frames: [{ filename: 'src/main/lib/credentials.ts' }] },
          },
        ],
      },
    };
    expect(beforeSend(event)).toBeNull();
  });

  it('drops events whose stack touches oauth.ts', () => {
    // Token exchange handles plaintext access_token / refresh_token in error paths.
    const event: ScrubbableEvent = {
      exception: {
        values: [{ stacktrace: { frames: [{ filename: 'src/main/lib/oauth.ts' }] } }],
      },
    };
    expect(beforeSend(event)).toBeNull();
  });

  it('does NOT drop unrelated paths that contain "oauth" as a substring', () => {
    // Guard against the regex over-matching. `oauth-config.ts` is not
    // sensitive — it shouldn't be dropped just because it contains "oauth".
    const event: ScrubbableEvent = {
      exception: {
        values: [{ stacktrace: { frames: [{ filename: 'src/lib/oauth-config.ts' }] } }],
      },
    };
    expect(beforeSend(event)).not.toBeNull();
  });

  it('drops events whose stack touches claude SDK paths', () => {
    const event: ScrubbableEvent = {
      exception: {
        values: [{ stacktrace: { frames: [{ abs_path: '/x/src/main/lib/claude/runner.ts' }] } }],
      },
    };
    expect(beforeSend(event)).toBeNull();
  });

  it('strips extra and request fields', () => {
    const event: ScrubbableEvent = {
      extra: { secret: 'leak' },
      request: { headers: { authorization: 'Bearer x' }, data: { p: 1 }, cookies: 'c=1' },
    };
    const out = beforeSend(event);
    expect(out?.extra).toBeUndefined();
    expect(out?.request?.headers).toBeUndefined();
    expect(out?.request?.data).toBeUndefined();
    expect(out?.request?.cookies).toBeUndefined();
  });

  it('normalizes paths in stack frames and redacts exception value', () => {
    const event: ScrubbableEvent = {
      exception: {
        values: [
          {
            value: 'fail token=sk-abcdefghijklmnopqrstuvwxyz1234567890',
            stacktrace: {
              frames: [
                {
                  filename: '/Users/benji/repo/src/x.ts',
                  abs_path: '/Users/benji/repo/src/x.ts',
                },
              ],
            },
          },
        ],
      },
    };
    const out = beforeSend(event);
    const frame = out?.exception?.values?.[0]?.stacktrace?.frames?.[0];
    expect(frame?.filename).toBe('/home/user/repo/src/x.ts');
    expect(frame?.abs_path).toBe('/home/user/repo/src/x.ts');
    expect(out?.exception?.values?.[0]?.value).toContain('[REDACTED]');
  });

  it('normalizes a user home path quoted inside the exception value', () => {
    // fs/shell errors name the offending path in their message, so the username
    // leaks through the value even when every stack frame is clean.
    const event: ScrubbableEvent = {
      exception: {
        values: [
          {
            value: "EACCES: permission denied, unlink '/Users/benji/private/notes.md'",
            stacktrace: { frames: [{ filename: 'src/x.ts', abs_path: 'src/x.ts' }] },
          },
        ],
      },
    };
    const value = beforeSend(event)?.exception?.values?.[0]?.value;
    expect(value).toBe("EACCES: permission denied, unlink '/home/user/private/notes.md'");
    expect(value).not.toContain('benji');
  });

  it('filters breadcrumbs in passed event', () => {
    const event: ScrubbableEvent = {
      breadcrumbs: [
        { category: 'console', message: 'noisy log' },
        { category: 'navigation', message: 'route change' },
      ],
    };
    const out = beforeSend(event);
    expect(out?.breadcrumbs).toHaveLength(1);
    expect(out?.breadcrumbs?.[0].category).toBe('navigation');
  });
});

describe('beforeBreadcrumb', () => {
  it.each(['navigation', 'ipc', 'ui.click', 'error', 'trpc'])('keeps category %s', (category) => {
    const b: ScrubbableBreadcrumb = { category, message: 'm' };
    expect(beforeBreadcrumb(b)).not.toBeNull();
  });

  it.each(['console', 'xhr', 'fetch', '', undefined])('drops category %s', (category) => {
    const b: ScrubbableBreadcrumb = { category: category as string | undefined, message: 'm' };
    expect(beforeBreadcrumb(b)).toBeNull();
  });

  it('replaces data values with their typeof', () => {
    const b: ScrubbableBreadcrumb = {
      category: 'ipc',
      data: { channel: 'auth:login', payload: { secret: 'abc' }, count: 7 },
    };
    const out = beforeBreadcrumb(b);
    expect(out?.data).toEqual({ channel: 'string', payload: 'object', count: 'number' });
  });

  it('redacts the message', () => {
    const b: ScrubbableBreadcrumb = {
      category: 'trpc',
      message: 'token=sk-abcdefghijklmnopqrstuvwxyz1234567890',
    };
    const out = beforeBreadcrumb(b);
    expect(out?.message).toBe('token=[REDACTED]');
  });
});
