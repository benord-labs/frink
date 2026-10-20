#!/usr/bin/env bun
// Before/after screenshots of one renderer component with no QA rig lock or app build.
// Usage and limits: scripts/qa/README.md, "Component before/after screenshots".
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import tailwindcss from '@tailwindcss/postcss';
import react from '@vitejs/plugin-react';
import { type Browser, chromium } from 'playwright-core';
import { createServer } from 'vite';
import { reactCompilerBabelPlugin } from '../../vitest.config';
import {
  BROWSER_CHANNELS,
  changedDependencyFiles,
  clearPreviousShots,
  existsAtCommit,
  finishShots,
  linkNodeModules,
  type PageResult,
  pageFailure,
  parseShotArgs,
  removeRunDir,
  resolveBaseCommit,
  type SideResult,
  settledValues,
  type ShotOptions,
} from './component-shot/lib';

declare global {
  interface Window {
    __componentShot: Pick<ShotOptions, 'exportName' | 'props' | 'fixture' | 'theme'> & {
      result?: PageResult;
    };
  }
}

const REPO = resolve(import.meta.dirname, '../..');
const HARNESS_FILES = [
  'src/renderer/lib/test-utils/component-shot-harness.tsx',
  'src/renderer/lib/test-utils/in-process-trpc-link.ts',
];
const READY_TIMEOUT_MS = 120_000;
const NODE_MODULES = realpathSync(join(REPO, 'node_modules'));
const nodeModulesLinks: string[] = [];

const toFsUrl = (path: string) => `/@fs/${path.replaceAll('\\', '/').replace(/^\//, '')}`;

/** Extracts the base commit's sources (read-only, no worktree registered) and gives it today's node_modules. */
function extractBaseTree(sha: string, tree: string, runDir: string): void {
  const tar = join(runDir, 'base.tar');
  execFileSync(
    'git',
    ['archive', '--format=tar', '-o', tar, sha, '--', 'src', 'package.json', 'tsconfig*.json'],
    {
      cwd: REPO,
    },
  );
  mkdirSync(tree);
  execFileSync('tar', ['-xf', tar, '-C', tree]);
  for (const file of HARNESS_FILES) copyFileSync(join(REPO, file), join(tree, file));
  nodeModulesLinks.push(linkNodeModules(NODE_MODULES, tree));
}

function writeEntry(runDir: string, tree: string, options: ShotOptions): void {
  const harness = toFsUrl(join(tree, HARNESS_FILES[0]));
  const css = toFsUrl(join(tree, 'src/renderer/styles/globals.css'));
  const module = toFsUrl(join(tree, options.modulePath));
  writeFileSync(
    join(runDir, 'index.html'),
    `<!doctype html><html lang="en" class="${options.theme}"><head><meta charset="UTF-8" /></head>` +
      '<body style="margin:0"><div id="root"></div><script type="module" src="./entry.js"></script></body></html>',
  );
  writeFileSync(
    join(runDir, 'entry.js'),
    `globalThis.electronTRPC = { onMessage: () => () => undefined, sendMessage: () => undefined };
const shot = window.__componentShot;
try {
  await import(${JSON.stringify(css)});
  const [{ mountComponentShot }, mod] = await Promise.all([import(${JSON.stringify(harness)}), import(${JSON.stringify(module)})]);
  const Component = mod[shot.exportName];
  if (Component == null) {
    shot.result = { missing: [], absent: true };
  } else {
    const state = mountComponentShot(document.getElementById('root'), Component, shot);
    await state.settled;
    shot.result = { missing: state.missing, rendered: document.getElementById('shot-root') !== null };
  }
} catch (err) {
  shot.result = { missing: [], error: err instanceof Error ? (err.stack ?? err.message) : String(err) };
}
`,
  );
}

type ShotServer = { url: string; close: () => Promise<void> };

// Vite's own listen() treats port 0 as "start at 5173", and concurrent servers can land on one port,
// so each side gets its own http server on a port the OS assigns.
async function startServer(runDir: string, tree: string, modulePath: string): Promise<ShotServer> {
  const vite = await createServer({
    configFile: false,
    root: runDir,
    logLevel: 'error',
    // Under a node_modules segment, so the React plugin leaves the pre-bundled deps alone.
    cacheDir: join(runDir, 'cache/node_modules/.vite'),
    plugins: [react({ babel: { plugins: [reactCompilerBabelPlugin] } })],
    resolve: { alias: { '@': join(tree, 'src/renderer'), path: 'path-browserify' } },
    css: { postcss: { plugins: [tailwindcss({ base: tree })] } },
    esbuild: { jsx: 'automatic' },
    // The scanner cannot follow the entry's /@fs/ imports, and the compiler adds its runtime import
    // after scanning. A dependency found mid-load is re-bundled, and with HMR off the page never reloads.
    optimizeDeps: {
      entries: [join(tree, HARNESS_FILES[0]), join(tree, modulePath)],
      include: ['react/compiler-runtime'],
    },
    server: {
      middlewareMode: true,
      hmr: false,
      ws: false,
      watch: null,
      fs: { allow: [runDir, tree, NODE_MODULES] },
    },
  });
  const http = createHttpServer(vite.middlewares);
  await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
  // SAFETY: a server listening on a TCP port reports an AddressInfo, never a pipe name or null.
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: async () => {
      http.close();
      await vite.close();
    },
  };
}

async function launchBrowser(): Promise<Browser> {
  const failures: string[] = [];
  for (const channel of BROWSER_CHANNELS) {
    try {
      return await chromium.launch({ channel });
    } catch (err) {
      const reason = err instanceof Error ? err.message.split('\n')[0] : String(err);
      failures.push(`${channel ?? 'bundled chromium'}: ${reason}`);
    }
  }
  throw new Error(
    `No browser to screenshot with. Install Google Chrome, or run \`bunx playwright-core install chromium\`.\n${failures.join('\n')}`,
  );
}

async function shootSide(
  browser: Browser,
  runDir: string,
  tree: string,
  png: string,
  options: ShotOptions,
): Promise<SideResult> {
  mkdirSync(runDir, { recursive: true });
  // optimizeDeps.include resolves from the Vite root.
  nodeModulesLinks.push(linkNodeModules(NODE_MODULES, runDir));
  writeEntry(runDir, tree, options);
  const server = await startServer(runDir, tree, options.modulePath);
  const context = await browser.newContext({
    viewport: { width: options.width, height: 800 },
    deviceScaleFactor: options.scale,
    colorScheme: options.theme,
  });
  try {
    const { exportName, props, fixture, theme } = options;
    const config = JSON.stringify({ exportName, props, fixture, theme });
    await context.addInitScript({ content: `window.__componentShot = ${config};` });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.stack ?? err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') pageErrors.push(msg.text());
    });
    await page.goto(server.url);
    await page.waitForFunction(() => window.__componentShot.result !== undefined, null, {
      timeout: READY_TIMEOUT_MS,
    });
    const result = await page.evaluate(() => window.__componentShot.result);
    const failure = pageFailure(result ?? { missing: [] }, pageErrors);
    if (failure) return failure;
    await page.locator('#shot-root').screenshot({ path: png, animations: 'disabled' });
    return { png, missing: result?.missing ?? [] };
  } finally {
    await context.close();
    await server.close();
  }
}

export async function main(argv: string[]): Promise<number> {
  const options = parseShotArgs(argv, REPO);
  const { base, head } = resolveBaseCommit(REPO, options.base);
  const out = options.out ? resolve(options.out) : mkdtempSync(join(tmpdir(), 'component-shot-'));
  mkdirSync(out, { recursive: true });
  clearPreviousShots(out);
  console.log(`before: ${options.base} merge-base ${base.slice(0, 10)}`);
  console.log(`after:  working tree on ${head.slice(0, 10)}`);
  if (base === head)
    console.warn('warning: the base is HEAD, so before differs only by uncommitted changes');
  const depChanges = changedDependencyFiles(REPO, base);
  if (depChanges.length) {
    console.warn(
      `warning: ${depChanges.join(', ')} changed since the base; before renders with today's node_modules`,
    );
  }

  const browser = await launchBrowser();
  const runDir = mkdtempSync(join(tmpdir(), 'frink-component-shot-'));
  const baseTree = join(runDir, 'base-tree');
  const onSignal = () => {
    removeRunDir(runDir, nodeModulesLinks);
    process.exit(130);
  };
  process.once('SIGINT', onSignal).once('SIGTERM', onSignal);
  try {
    const baseHasModule = existsAtCommit(REPO, base, options.modulePath);
    if (baseHasModule) extractBaseTree(base, baseTree, runDir);
    const absent: SideResult = { missing: [], absent: true };
    // Both sides finish before the finally below closes the browser and deletes their folders.
    const [before, after] = settledValues(
      await Promise.allSettled([
        baseHasModule
          ? shootSide(browser, join(runDir, 'base'), baseTree, join(out, 'before.png'), options)
          : absent,
        shootSide(browser, join(runDir, 'head'), REPO, join(out, 'after.png'), options),
      ]),
    );
    const report = finishShots({ before, after, ...options, base });
    for (const line of report.lines) console.log(line);
    if (report.missing.length) {
      console.error(
        `no fixture answer for: ${report.missing.join(', ')} (add them to --trpc-fixture)`,
      );
    }
    return report.code;
  } finally {
    process.off('SIGINT', onSignal).off('SIGTERM', onSignal);
    await browser.close();
    removeRunDir(runDir, nodeModulesLinks);
  }
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
