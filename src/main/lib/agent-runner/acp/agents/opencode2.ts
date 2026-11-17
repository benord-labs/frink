import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { frinkUserHome } from '../../../platform/frink-home';
import type { AcpLaunchRow, LaunchCheck, LaunchContext } from './launch';
import { instructionFiles, OPENCODE_LAUNCH, PERMISSION, skillPaths } from './opencode';

/** OpenCode 2's names for the tools OpenCode 1.19 calls `bash` and `task`. */
const RENAMED = new Map([
  ['bash', 'shell'],
  ['task', 'subagent'],
]);

/** Administrator settings OpenCode 2 reads above Frink's own; any of them present refuses. */
const managedSettings = () => [
  '/Library/Application Support/opencode',
  `/Library/Managed Preferences/${os.userInfo().username}/ai.opencode.managed.plist`,
  '/Library/Managed Preferences/ai.opencode.managed.plist',
  '/etc/opencode',
];

/** OpenCode 1.19's permission map as OpenCode 2's ordered list, where the last matching rule wins. */
function permissionList({ '*': all, read, ...tools }: typeof PERMISSION) {
  const rule = (action: string, effect: string, resource = '*') => ({ action, resource, effect });
  return [
    rule('*', all),
    ...Object.entries(read).map(([resource, effect]) => rule('read', effect, resource)),
    ...Object.entries(tools).map(([tool, effect]) => rule(RENAMED.get(tool) ?? tool, effect)),
    // Code Mode runs the model's own code, with a network fetch that never asks.
    rule('execute', 'deny'),
  ];
}

const SettingsSources = z.array(
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('directory'), path: z.string() }),
    z.object({
      type: z.literal('document'),
      path: z.string().optional(),
      info: z.record(z.string(), z.json()),
    }),
  ]),
);
const SignIns = z.array(z.object({ id: z.string() }));
const SavedAnswers = z.object({ data: z.array(z.object({ id: z.string() })) });

/** Checks that only Frink's settings reach OpenCode 2, and no sign-in or saved answer outranks them. */
export function openCode2Checks(
  configDir: string,
  content: string,
  data: string,
  managed: readonly string[] = managedSettings(),
): LaunchCheck[] {
  const onlyFrinks = (stdout: string) => {
    const sources = SettingsSources.safeParse(JSON.parse(stdout));
    if (!sources.success || sources.data.length !== 2 || managed.some(existsSync)) return false;
    const [folder, document] = sources.data;
    return (
      folder.type === 'directory' &&
      realpathSync.native(folder.path) === realpathSync.native(configDir) &&
      document.type === 'document' &&
      document.path === undefined &&
      isDeepStrictEqual(document.info, JSON.parse(content))
    );
  };
  return [
    { args: ['debug', 'config'], passes: ({ stdout }) => onlyFrinks(stdout) },
    // A sign-in source named by a web address sends settings again at start and every few minutes.
    {
      args: ['auth', 'list', '--format', 'json'],
      passes: ({ stdout }) => {
        const signIns = SignIns.safeParse(JSON.parse(stdout));
        return signIns.success && !signIns.data.some(({ id }) => URL.canParse(id));
      },
    },
    // Any OpenCode run on this folder can save "Always allow" answers, which outrank every ask.
    {
      args: ['api', 'GET', '/api/permission/saved', '--standalone'],
      passes: ({ stdout }) => SavedAnswers.safeParse(JSON.parse(stdout)).data?.data.length === 0,
      refusal: `OpenCode has saved "Always allow" answers in the folder Frink keeps for it, so it wouldn't ask Frink first. Delete ${data}, then try again.`,
    },
  ];
}

async function openCode2Settings(context: LaunchContext) {
  const permissions = permissionList(PERMISSION);
  const config = {
    permissions,
    agents: {
      build: { permissions },
      plan: { permissions: permissionList({ ...PERMISSION, edit: 'deny' }) },
    },
    default_agent: 'build',
    share: 'disabled',
    update: 'disable',
    formatter: false,
    lsp: false,
    shell: context.shellGate,
    skills: await skillPaths(context),
  };
  const configDir = path.join(context.dirs.config, 'opencode');
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  // OpenCode 2 reads instructions only from AGENTS.md files; this one is in its private folder.
  const files = await instructionFiles(context);
  const instructions = await Promise.all(files.map((file) => readFile(file, 'utf8')));
  if (files.length > 0)
    await writeFile(path.join(configDir, 'AGENTS.md'), instructions.join('\n\n'));
  // Without this, OpenCode's own commands join or start the user's background service.
  await writeFile(path.join(configDir, 'service.json'), '{"disabled":true}', { mode: 0o600 });
  const data = path.join(frinkUserHome(), '.frink', 'opencode', 'data');
  await mkdir(data, { recursive: true, mode: 0o700 });
  const env = {
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    // The settings sources are checked before the turn, so none may load while it runs.
    OPENCODE_DISABLE_FILEWATCHER: '1',
    XDG_CONFIG_HOME: context.dirs.config,
    OPENCODE_TEST_HOME: context.dirs.home,
    // Chats, saved answers and sign-ins Frink's launches alone use, so the user's OpenCode never resumes them.
    XDG_DATA_HOME: data,
  };
  return { env, checks: openCode2Checks(configDir, env.OPENCODE_CONFIG_CONTENT, data) };
}

export const OPENCODE2_LAUNCH: AcpLaunchRow = {
  ...OPENCODE_LAUNCH,
  versions: { floor: '2.0.29', below: '2.1.0' },
  signInHint: 'XDG_DATA_HOME=$HOME/.frink/opencode/data opencode auth login --standalone',
  args: ['acp'],
  settings: openCode2Settings,
  rules: {
    toolQuestions: {
      shell: 'Bash',
      read: 'Read',
      glob: 'Read',
      grep: 'Read',
      write: 'Edit',
      edit: 'Edit',
      patch: 'Edit',
      webfetch: 'WebFetch',
      websearch: 'WebSearch',
    },
    ignoredInputKeys: ['content', 'oldString', 'newString', 'format'],
    quietTools: ['read', 'glob', 'grep', 'skill'],
    inputNames: { file: 'path', sessionFolder: 'cwd' },
  },
};
