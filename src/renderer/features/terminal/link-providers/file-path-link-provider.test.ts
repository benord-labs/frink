import { describe, expect, it, vi } from 'vitest';

// Minimal xterm buffer line stub
function makeBufferLine(text: string) {
  return {
    length: text.length,
    getCell: (i: number) => ({ getChars: () => text[i] ?? '' }),
  };
}

// Minimal xterm stub
function makeXterm(lineText: string) {
  return {
    buffer: {
      active: {
        getLine: (_n: number) => makeBufferLine(lineText),
      },
    },
  };
}

// Mock link-popup to avoid DOM dependency (imported by file-path-link-provider)
vi.mock('./link-popup', () => ({
  isModifierPressed: vi.fn(() => false),
  showLinkPopup: vi.fn(),
  removeLinkPopup: vi.fn(),
}));

describe('FilePathLinkProvider', () => {
  it('resolves without hanging for lines with no file-like paths', async () => {
    const { FilePathLinkProvider } = await import('./file-path-link-provider');

    const xterm = makeXterm('no paths here, just text /usr/bin/env and /etc/hosts stuff');
    // biome-ignore lint/suspicious/noExplicitAny: Intentional for testing
    const provider = new FilePathLinkProvider(xterm as any, vi.fn());

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('provideLinks timed out — infinite loop!')),
        500,
      );
      provider.provideLinks(0, (_links) => {
        clearTimeout(timeout);
        resolve();
      });
    });
  });

  it('detects file path links on lines that have them', async () => {
    const { FilePathLinkProvider } = await import('./file-path-link-provider');

    const xterm = makeXterm('Error at /Users/foo/project/src/main.ts:42:10');
    const onClick = vi.fn();
    // biome-ignore lint/suspicious/noExplicitAny: Intentional for testing
    const provider = new FilePathLinkProvider(xterm as any, onClick);

    const links = await new Promise<unknown[]>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out')), 500);
      provider.provideLinks(0, (l) => {
        clearTimeout(timeout);
        resolve(l ?? []);
      });
    });

    expect(links.length).toBeGreaterThan(0);
  });

  it('does not hang when a matched path has no file extension (regression: infinite loop on continue)', async () => {
    const { FilePathLinkProvider } = await import('./file-path-link-provider');

    // Path with no extension and no known extensionless filename → looksLikeFile returns false
    // Before the fix, continue skipped exec() → lastIndex did not advance → infinite loop
    const xterm = makeXterm('Running /usr/local/bin/node version check');
    // biome-ignore lint/suspicious/noExplicitAny: Intentional for testing
    const provider = new FilePathLinkProvider(xterm as any, vi.fn());

    const links = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('provideLinks timed out — infinite loop regression!')),
        500,
      );
      provider.provideLinks(0, (l) => {
        clearTimeout(timeout);
        resolve(l);
      });
    });

    // No file-like paths → callback receives undefined
    expect(links).toBeUndefined();
  });
});
