import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';

const JsonObjectSchema = z.record(z.string(), z.json());
type JsonObject = z.infer<typeof JsonObjectSchema>;

export type ShotOptions = {
  /** Repo-relative, forward slashes: also the path inside the base commit. */
  modulePath: string;
  exportName: string;
  props: JsonObject;
  fixture: JsonObject;
  base: string;
  width: number;
  scale: number;
  theme: 'dark' | 'light';
  out: string | undefined;
};

export const USAGE = `Usage: bun scripts/qa/component-shot.ts <module> <Export>
  [--props '<json>' | --props-file <file>] [--trpc-fixture <file>]
  [--base origin/main] [--width 780] [--scale 2] [--theme dark|light] [--out <dir>]`;

// Exit codes beyond 0 (shot) and 1 (error), so a caller can tell an incomplete shot apart.
export const EXIT_UNANSWERED = 2;
export const EXIT_ABSENT_AT_BASE = 3;

const parseJsonObject = (text: string) => JsonObjectSchema.parse(JSON.parse(text));
const readJsonObject = (file: string) => parseJsonObject(readFileSync(file, 'utf8'));

function positiveNumber(flag: string, raw: string): number {
  const value = Number(raw);
  if (!(value > 0 && Number.isFinite(value))) throw new Error(`${flag} must be a positive number`);
  return value;
}

function readProps(inline: string | undefined, file: string | undefined): JsonObject {
  if (inline && file) throw new Error('Pass --props or --props-file, not both');
  if (inline) return parseJsonObject(inline);
  return file ? readJsonObject(file) : {};
}

function repoRelative(module: string, repoRoot: string): string {
  const path = relative(repoRoot, isAbsolute(module) ? module : resolve(module));
  const modulePath = path.replaceAll('\\', '/');
  if (modulePath.startsWith('../')) throw new Error(`${module} is outside the repository`);
  return modulePath;
}

export function parseShotArgs(argv: string[], repoRoot: string): ShotOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      props: { type: 'string' },
      'props-file': { type: 'string' },
      'trpc-fixture': { type: 'string' },
      base: { type: 'string', default: 'origin/main' },
      width: { type: 'string', default: '780' },
      scale: { type: 'string', default: '2' },
      theme: { type: 'string', default: 'dark' },
      out: { type: 'string' },
    },
  });
  const [module, exportName] = positionals;
  if (!module || !exportName || positionals.length > 2) throw new Error(USAGE);
  const { theme } = values;
  if (theme !== 'dark' && theme !== 'light') throw new Error('--theme is dark or light');
  return {
    modulePath: repoRelative(module, repoRoot),
    exportName,
    props: readProps(values.props, values['props-file']),
    fixture: values['trpc-fixture'] ? readJsonObject(values['trpc-fixture']) : {},
    base: values.base,
    width: positiveNumber('--width', values.width),
    scale: positiveNumber('--scale', values.scale),
    theme,
    out: values.out,
  };
}

const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** The commit a branch forked from, so commits that landed on `base` later never show as a change. */
export function resolveBaseCommit(repoRoot: string, base: string) {
  return {
    base: git(repoRoot, ['merge-base', base, 'HEAD']),
    head: git(repoRoot, ['rev-parse', 'HEAD']),
  };
}

export function existsAtCommit(repoRoot: string, sha: string, path: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}:${path}`], { cwd: repoRoot, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Dependency files that differ between `sha` and the working tree: the base side renders with today's node_modules. */
export function changedDependencyFiles(repoRoot: string, sha: string): string[] {
  const out = git(repoRoot, ['diff', '--name-only', sha, '--', 'package.json', 'bun.lock']);
  return out ? out.split('\n') : [];
}

/** Windows needs a junction: a directory symlink there requires admin rights or Developer Mode. */
export const nodeModulesLinkType = (platform: NodeJS.Platform) =>
  platform === 'win32' ? 'junction' : 'dir';

/** Links `nodeModules` into `dir`, so packages resolve from it as they do from the repo root. */
export function linkNodeModules(nodeModules: string, dir: string): string {
  const link = join(dir, 'node_modules');
  symlinkSync(nodeModules, link, nodeModulesLinkType(process.platform));
  return link;
}

/** Drops the node_modules links before deleting, so the repo's real node_modules is never touched. */
export function removeRunDir(runDir: string, links: string[]): void {
  for (const link of links.splice(0)) unlinkSync(link);
  rmSync(runDir, { recursive: true, force: true });
}

/** A skipped before shot must not leave an earlier run's before.png looking current. */
export function clearPreviousShots(out: string): void {
  for (const png of ['before.png', 'after.png']) rmSync(join(out, png), { force: true });
}

/** Installed Chrome, then Edge, then a browser fetched with `playwright-core install`. */
export const BROWSER_CHANNELS = ['chrome', 'msedge', undefined] as const;

/** What the page's entry script records once the component settled, failed or was not found. */
export type PageResult = {
  missing: string[];
  rendered?: boolean;
  absent?: boolean;
  error?: string;
};

export type SideResult = { png?: string; missing: string[]; absent?: boolean; error?: string };

/** Why a settled page must not be screenshotted, or null when it rendered. */
export function pageFailure(result: PageResult, pageErrors: string[]): SideResult | null {
  if (result.absent) return { missing: [], absent: true };
  // A render error unmounts the whole root, so a settled page can still hold nothing.
  const error = result.error ?? (result.rendered ? undefined : 'the component unmounted');
  return error ? { missing: [], error: [error, ...pageErrors].join('\n') } : null;
}

type Shots = {
  before: SideResult;
  after: SideResult;
  exportName: string;
  modulePath: string;
  base: string;
};

/** The run's report lines and exit code; throws when a side failed outright. */
export function finishShots({ before, after, exportName, modulePath, base }: Shots) {
  if (after.error) throw new Error(`after: ${after.error}`);
  if (after.absent) throw new Error(`${exportName} is not exported from ${modulePath}`);
  if (before.error) throw new Error(`before: ${before.error}`);
  const missing = [...new Set([...before.missing, ...after.missing])];
  const lines = [
    'component harness render, not the full app',
    before.png
      ? `before.png  ${before.png}`
      : `before.png  not written: ${exportName} is absent at ${base.slice(0, 10)}`,
    `after.png   ${after.png}`,
  ];
  if (missing.length) return { lines, missing, code: EXIT_UNANSWERED };
  return { lines, missing, code: before.absent ? EXIT_ABSENT_AT_BASE : 0 };
}
