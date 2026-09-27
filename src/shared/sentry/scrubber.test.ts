import { describe, expect, it } from 'vitest';
import { normalizeUserPath, redactString, scrubText } from './redaction';
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

  it('replaces a Windows home with a lowercase drive letter', () => {
    const out = normalizeUserPath('c:\\Users\\alice\\App\\x.ts');
    expect(out).toBe('/home/user\\App\\x.ts');
  });

  it('replaces a JSON-escaped Windows home', () => {
    // MCP errors often arrive JSON-stringified, doubling every backslash.
    const out = normalizeUserPath('{"path":"C:\\\\Users\\\\alice\\\\x.ts"}');
    expect(out).not.toContain('alice');
  });

  it('replaces a Windows username containing a space', () => {
    // Windows account names may contain spaces; macOS/Linux short names may not.
    const out = normalizeUserPath('ENOENT C:\\Users\\Jane Doe\\AppData\\x.js');
    expect(out).toBe('ENOENT /home/user\\AppData\\x.js');
  });

  it.each(['Jane Doe+Smith', 'jane,corp', 'jane;x', 'jane=x', 'jane [old]'])(
    'replaces a Windows profile folder %s containing folder-legal punctuation',
    (name) => {
      const out = normalizeUserPath(`ENOENT C:\\Users\\${name}\\x.js`);
      expect(out).toBe('ENOENT /home/user\\x.js');
    },
  );

  it.each([
    ["cwd 'C:\\Users\\Jane Doe' missing", "cwd '/home/user' missing"],
    ['cwd "C:\\Users\\Jane Doe" missing', 'cwd "/home/user" missing'],
    ['cwd `C:\\Users\\Jane Doe` missing', 'cwd `/home/user` missing'],
    ['(C:\\Users\\Jane Doe)', '(/home/user)'],
    ['at C:\\Users\\Jane Doe, retrying', 'at /home/user, retrying'],
    ["'C:\\Users\\O'Brien' gone", "'/home/user' gone"],
    ['{"cwd":"C:\\\\Users\\\\Jane Doe"}', '{"cwd":"/home/user"}'],
  ])('replaces a delimited Windows home ending the path: %s', (input, expected) => {
    expect(normalizeUserPath(input)).toBe(expected);
  });

  it('does not swallow prose after a Windows home that ends the path', () => {
    expect(normalizeUserPath('cwd C:\\Users\\alice is missing')).toBe('cwd /home/user is missing');
  });

  it('replaces every home path in a string, across platforms', () => {
    const out = normalizeUserPath(
      'spawn /Users/alice/a.js failed; fallback /home/bob/b.js; C:\\Users\\carol\\c.js',
    );
    expect(out).toBe('spawn /home/user/a.js failed; fallback /home/user/b.js; /home/user\\c.js');
  });

  it('replaces a bare home directory with no trailing path', () => {
    expect(normalizeUserPath("cwd '/Users/alice' not found")).toBe("cwd '/home/user' not found");
  });

  it('replaces a home inside a file:// URL', () => {
    expect(normalizeUserPath('file:///Users/alice/x.js')).toBe('file:///home/user/x.js');
  });

  it('is idempotent, so double scrubbing a breadcrumb is harmless', () => {
    const once = normalizeUserPath('/Users/alice/x and C:\\Users\\Jane Doe\\y');
    expect(normalizeUserPath(once)).toBe(once);
  });
});

describe('scrubText', () => {
  it('normalizes a home path and redacts a token in one pass', () => {
    const out = scrubText('at /Users/alice/x key=sk-abcdefghijklmnopqrstuvwxyz1234567890');
    expect(out).toBe('at /home/user/x key=[REDACTED]');
  });

  it('normalizes a home whose username is long enough to look like a token', () => {
    expect(scrubText('/Users/abcdefghijklmnopqrstuvwxyz0123456789/f')).toBe('/home/user/f');
  });

  it('returns empty input unchanged', () => {
    expect(scrubText('')).toBe('');
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

  it.each([
    [
      'macOS',
      'ENOENT /Users/alice/Desktop/mcp/build/index.js',
      'ENOENT /home/user/Desktop/mcp/build/index.js',
    ],
    ['Linux', 'ENOENT /home/alice/mcp/index.js', 'ENOENT /home/user/mcp/index.js'],
    ['Windows', 'ENOENT C:\\Users\\alice\\mcp\\index.js', 'ENOENT /home/user\\mcp\\index.js'],
  ])('normalizes a %s home path in event.message', (_os, input, expected) => {
    // captureMainMessage lands in event.message, not exception.values.
    const event: ScrubbableEvent = {
      message: `MCP stdio transport failure (spawn): ${input}`,
    };
    const message = beforeSend(event)?.message;
    expect(message).toBe(`MCP stdio transport failure (spawn): ${expected}`);
    expect(message).not.toContain('alice');
  });

  it('scrubs message, exception value and breadcrumb message identically', () => {
    // The drift between these fields is what leaked the username; lock parity.
    const input =
      "Cannot find module '/Users/alice/x/index.js' token=sk-abcdefghijklmnopqrstuvwxyz1234567890";
    const event: ScrubbableEvent = {
      message: input,
      exception: { values: [{ value: input, stacktrace: { frames: [{ filename: 'src/x.ts' }] } }] },
      breadcrumbs: [{ category: 'trpc', message: input }],
    };
    const out = beforeSend(event);
    const expected = scrubText(input);
    expect(expected).not.toContain('alice');
    expect(expected).toContain('[REDACTED]');
    expect(out?.message).toBe(expected);
    expect(out?.exception?.values?.[0]?.value).toBe(expected);
    expect(out?.breadcrumbs?.[0]?.message).toBe(expected);
  });

  it('scrubs a parameterized message in event.logentry', () => {
    // Sentry.parameterize writes logentry and never sets event.message.
    const event: ScrubbableEvent = {
      logentry: {
        message: 'spawn failed at /Users/alice/%s',
        params: ['/Users/alice/x.js', { cwd: '/Users/alice' }, 7],
      },
    };
    const out = beforeSend(event);
    expect(out?.logentry?.message).toBe('spawn failed at /home/user/%s');
    expect(out?.logentry?.params).toEqual(['/home/user/x.js', 'object', 'number']);
  });

  it('tolerates a logentry without params', () => {
    const event: ScrubbableEvent = { logentry: { message: '/home/alice/x' } };
    const out = beforeSend(event);
    expect(out?.logentry).toEqual({ message: '/home/user/x' });
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

  it('normalizes a home path in the message', () => {
    const b: ScrubbableBreadcrumb = { category: 'error', message: 'EPERM /home/alice/.config/x' };
    expect(beforeBreadcrumb(b)?.message).toBe('EPERM /home/user/.config/x');
  });
});
