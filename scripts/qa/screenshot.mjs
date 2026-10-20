// node scripts/qa/screenshot.mjs <out.png> [--width 1280] [--height 800] — saves the booted QA app's
// window as a PNG at a fixed size, so a base-branch and a head-branch capture line up.
import { realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { connectPage } from './bench/cdp.mjs';

const USAGE = 'usage: screenshot.mjs <out.png> [--width 1280] [--height 800]';

/** The output path and viewport, or an error naming what is wrong with the arguments. */
export function parseScreenshotArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      width: { type: 'string', default: '1280' },
      height: { type: 'string', default: '800' },
    },
  });
  const width = Number(values.width);
  const height = Number(values.height);
  if (positionals.length !== 1 || !positionals[0].endsWith('.png')) throw new Error(USAGE);
  if (![width, height].every((n) => Number.isInteger(n) && n > 0)) {
    throw new Error(`--width and --height must be positive integers — ${USAGE}`);
  }
  return { out: positionals[0], width, height };
}

/** One PNG of the page at width×height; the window's own size is restored afterwards. */
export async function capture(page, { width, height }) {
  await page.call('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 0,
    mobile: false,
  });
  try {
    // Two frames, so the layout at the new size has painted before the capture.
    await page.evaluate(
      'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))',
    );
    const { data } = await page.call('Page.captureScreenshot', { format: 'png' });
    return Buffer.from(data, 'base64');
  } finally {
    await page.call('Emulation.clearDeviceMetricsOverride');
  }
}

/** The command line: parse, capture, write. Returns the process exit code. */
export async function main(argv, io) {
  let args;
  try {
    args = parseScreenshotArgs(argv);
  } catch (error) {
    io.error(error.message);
    return 2;
  }
  const page = await io.connect();
  try {
    io.write(args.out, await capture(page, args));
    io.log(`saved ${args.out} (${args.width}×${args.height}) from ${page.url}`);
    return 0;
  } finally {
    page.close();
  }
}

const invokedDirectly =
  process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const io = { connect: connectPage, write: writeFileSync, log: console.log, error: console.error };
  process.exit(await main(process.argv.slice(2), io));
}
