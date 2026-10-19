import { describe, expect, it } from 'vitest';
import { capture, main, parseScreenshotArgs } from './screenshot.mjs';

describe('parseScreenshotArgs', () => {
  it('defaults to 1280×800', () => {
    expect(parseScreenshotArgs(['after.png'])).toEqual({
      out: 'after.png',
      width: 1280,
      height: 800,
    });
  });

  it('takes an explicit size', () => {
    expect(parseScreenshotArgs(['b.png', '--width', '1000', '--height', '560'])).toEqual({
      out: 'b.png',
      width: 1000,
      height: 560,
    });
  });

  it('refuses a missing or non-PNG path, and a size that is not a positive integer', () => {
    expect(() => parseScreenshotArgs([])).toThrow(/usage/);
    expect(() => parseScreenshotArgs(['shot.jpg'])).toThrow(/usage/);
    expect(() => parseScreenshotArgs(['a.png', 'b.png'])).toThrow(/usage/);
    expect(() => parseScreenshotArgs(['a.png', '--width', '0'])).toThrow(/positive integers/);
    expect(() => parseScreenshotArgs(['a.png', '--height', '7.5'])).toThrow(/positive integers/);
  });
});

describe('capture', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const fakePage = (failCapture = false) => {
    const calls = [];
    return {
      calls,
      evaluate: async (expression) => calls.push(['evaluate', expression]),
      call: async (method, params) => {
        calls.push([method, params]);
        if (method === 'Page.captureScreenshot') {
          if (failCapture) throw new Error('target closed');
          return { data: png.toString('base64') };
        }
        return {};
      },
    };
  };

  it('captures at the requested size, after a paint, and restores the window size', async () => {
    const page = fakePage();
    expect(await capture(page, { width: 1000, height: 560 })).toEqual(png);
    expect(page.calls.map(([method]) => method)).toEqual([
      'Emulation.setDeviceMetricsOverride',
      'evaluate',
      'Page.captureScreenshot',
      'Emulation.clearDeviceMetricsOverride',
    ]);
    expect(page.calls[0][1]).toMatchObject({ width: 1000, height: 560, mobile: false });
  });

  it('restores the window size even when the capture fails', async () => {
    const page = fakePage(true);
    await expect(capture(page, { width: 1280, height: 800 })).rejects.toThrow('target closed');
    expect(page.calls.at(-1)[0]).toBe('Emulation.clearDeviceMetricsOverride');
  });
});

describe('main', () => {
  const run = async (argv) => {
    const out = { written: [], logs: [], errors: [], closed: false };
    const page = {
      url: 'file:///repo/out-qa/renderer/index.html',
      evaluate: async () => {},
      call: async (method) => (method === 'Page.captureScreenshot' ? { data: 'iVBO' } : {}),
      close: () => {
        out.closed = true;
      },
    };
    const io = {
      connect: async () => page,
      write: (path, bytes) => out.written.push([path, bytes.length]),
      log: (line) => out.logs.push(line),
      error: (line) => out.errors.push(line),
    };
    return { code: await main(argv, io), ...out };
  };

  it('writes the PNG, says what it captured, and closes the page', async () => {
    const result = await run(['after.png', '--width', '1000', '--height', '560']);
    expect(result.code).toBe(0);
    expect(result.written).toEqual([['after.png', 3]]);
    expect(result.logs).toEqual([
      'saved after.png (1000×560) from file:///repo/out-qa/renderer/index.html',
    ]);
    expect(result.closed).toBe(true);
  });

  it('exits 2 with the usage line, without connecting, on bad arguments', async () => {
    const result = await run(['shot.jpg']);
    expect(result.code).toBe(2);
    expect(result.errors[0]).toMatch(/usage/);
    expect(result.written).toEqual([]);
  });
});
