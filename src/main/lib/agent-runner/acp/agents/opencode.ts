import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { AI_PROVIDERS } from '../../../../../shared/lib/ai-providers';
import type { AcpLaunchRow, LaunchCheck, LaunchContext } from './launch';

/**
 * Every tool asks, except tools that only read; environment files still ask. Each risky tool is
 * named so no merged setting can swap its answer. Subagents and questions never reach Frink.
 */
const PERMISSION = {
  '*': 'ask',
  read: { '*': 'allow', '*.env': 'ask', '*.env.*': 'ask', '*.env.example': 'allow' },
  glob: 'allow',
  grep: 'allow',
  list: 'allow',
  skill: 'allow',
  todowrite: 'allow',
  bash: 'ask',
  edit: 'ask',
  webfetch: 'ask',
  websearch: 'ask',
  codesearch: 'ask',
  external_directory: 'ask',
  doom_loop: 'ask',
  task: 'deny',
  question: 'deny',
};

/** The settings OpenCode reports as in effect, after every source merged in. */
const EffectiveSettings = z.record(z.string(), z.json());
type Settings = z.infer<typeof EffectiveSettings>;

/** Keys OpenCode adds to every launch's effective settings, as a clean launch reports them. */
const OPENCODE_ADDS = { plugin: [], mode: {}, command: {} };

/** The settings as JSON with top-level keys sorted, so equal settings give the same text. */
function canonical(settings: Settings): string {
  const entries = Object.entries(settings).sort(([a], [b]) => (a < b ? -1 : 1));
  return JSON.stringify(Object.fromEntries(entries));
}

async function existing(files: string[]): Promise<string | undefined> {
  for (const file of files) {
    if (
      await stat(file).then(
        () => true,
        () => false,
      )
    )
      return file;
  }
  return undefined;
}

/** The project's instructions, then the user's own, in the order OpenCode itself would read them. */
async function instructionFiles({ projectRoot, userEnv }: LaunchContext): Promise<string[]> {
  const home = userEnv.HOME ?? os.homedir();
  const configHome = userEnv.XDG_CONFIG_HOME ?? path.join(home, '.config');
  const files = await Promise.all([
    existing(['AGENTS.md', 'CLAUDE.md'].map((name) => path.join(projectRoot, name))),
    existing([
      path.join(configHome, 'opencode', 'AGENTS.md'),
      path.join(home, '.claude', 'CLAUDE.md'),
    ]),
  ]);
  return files.filter((file) => file !== undefined);
}

/** The user's own skill folders, which OpenCode no longer finds once its home is private. */
async function skillPaths({ userEnv }: LaunchContext): Promise<string[]> {
  const home = userEnv.HOME ?? os.homedir();
  const folders = [path.join(home, '.claude', 'skills'), path.join(home, '.agents', 'skills')];
  const found = await Promise.all(folders.map((folder) => existing([folder])));
  return found.filter((folder) => folder !== undefined);
}

async function openCodeSettings(context: LaunchContext) {
  const config = {
    permission: PERMISSION,
    // OpenCode reports each agent with empty options, so they are written out to compare equal.
    agent: {
      build: { permission: PERMISSION, options: {} },
      plan: { permission: { ...PERMISSION, edit: 'deny' }, options: {} },
    },
    default_agent: 'build',
    share: 'disabled',
    autoupdate: false,
    formatter: false,
    lsp: false,
    // A refusal ends only that step, so the agent can carry on another way.
    experimental: { continue_loop_on_deny: true },
    shell: context.shellGate,
    instructions: await instructionFiles(context),
    skills: { paths: await skillPaths(context) },
  };
  // Language servers, formatters and providers run code outside the shell gate, so any key the
  // launch did not set refuses. Only the user name, a display default, may differ.
  const keepsRules = (stdout: string) => {
    const parsed = EffectiveSettings.safeParse(JSON.parse(stdout));
    if (!parsed.success) return false;
    const expected: Settings = { ...config, ...OPENCODE_ADDS, username: parsed.data.username };
    return canonical(parsed.data) === canonical(expected);
  };
  const checks: LaunchCheck[] = [
    // Remote settings are fetched again at start, so a source must refuse even when it adds
    // nothing now. OpenCode marks each one with `$schema`, which the launch never sets.
    { args: ['debug', 'config', '--pure'], passes: ({ stdout }) => keepsRules(stdout) },
    // An organisation account's settings are also fetched again at start, so none may be signed in.
    { args: ['console', 'orgs'], passes: ({ stderr }) => stderr.includes('No accounts found') },
  ];
  const env = {
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_SERVER_PASSWORD: context.password,
    // Private folders hide the user's and any earlier launch's settings, tools and plugins.
    XDG_CONFIG_HOME: context.dirs.config,
    OPENCODE_TEST_HOME: context.dirs.home,
  };
  return { env, checks };
}

export const OPENCODE_LAUNCH: AcpLaunchRow = {
  name: AI_PROVIDERS.opencode.name,
  binary: 'opencode',
  fallbacks: ['.opencode/bin/opencode'],
  versions: { floor: '1.19.0', below: '1.20.0' },
  installHint: AI_PROVIDERS.opencode.installHint,
  args: ['acp', '--pure', '--hostname', '127.0.0.1', '--port', '0'],
  envPrefix: 'OPENCODE_',
  settings: openCodeSettings,
  rules: {
    toolQuestions: {
      bash: 'Bash',
      read: 'Read',
      glob: 'Read',
      grep: 'Read',
      list: 'Read',
      write: 'Edit',
      edit: 'Edit',
      apply_patch: 'Edit',
      webfetch: 'WebFetch',
      websearch: 'WebSearch',
    },
    // Derived from the command and its working folder, which the question already carries.
    ignoredInputKeys: ['directories', 'patterns', 'parentDir', 'numResults', 'provider'],
    quietTools: ['read', 'glob', 'grep', 'list', 'todowrite', 'skill'],
  },
};
