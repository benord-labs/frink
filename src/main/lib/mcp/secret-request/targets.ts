import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SecretGitState, SecretMainCheckout } from '../../../../shared/types/task-signal';
import { isPathWithinProject } from '../../permissions/path-check';
import { hasEnvKey, SecretRequestError } from './env-file';
import { gitCommonDir, gitStateOf, repoTopLevel } from './git-state';

const ENV_BASENAME = /^\.env(\.[A-Za-z0-9_-]+)*$/;
const TEMPLATE_NAME = /example|sample|template/i;

export type SecretTarget = {
  /** Absolute path through the real parent folder, so a later rename cannot follow a link. */
  target: string;
  rel: string;
  replaces: boolean;
  git: SecretGitState;
};

async function realpathOrNull(p: string): Promise<string | null> {
  return fs.realpath(p).catch(() => null);
}

/**
 * Where a secret for `key` may be written: a plain `.env`-style file whose folder already exists
 * inside the chat folder. Throws a `SecretRequestError` the user or agent can act on.
 */
export async function resolveSecretTarget(
  cwd: string | undefined,
  file: string,
  key: string,
): Promise<SecretTarget> {
  const root = cwd ? await realpathOrNull(cwd) : null;
  if (!root || root === (await realpathOrNull(os.homedir()))) {
    throw new SecretRequestError('Open this chat in a project folder to save secrets.');
  }
  const base = path.basename(file);
  if (!ENV_BASENAME.test(base) || TEMPLATE_NAME.test(base)) {
    throw new SecretRequestError(`${file} is not an env file. Use .env or a name like .env.local.`);
  }
  if (path.isAbsolute(file) || path.normalize(file).split(path.sep).includes('..')) {
    throw new SecretRequestError(`${file} must be a path inside the project.`);
  }
  const parent = await realpathOrNull(path.dirname(path.join(root, file)));
  if (!parent || !isPathWithinProject(parent, root)) {
    throw new SecretRequestError(`The folder for ${file} does not exist in this project.`);
  }
  const target = path.join(parent, base);
  const stat = await fs.lstat(target).catch(() => null);
  if (stat && !stat.isFile()) {
    throw new SecretRequestError(`${file} is a link or a folder, so Frink will not write to it.`);
  }
  const content = stat ? await fs.readFile(target, 'utf8') : '';
  const rel = path.relative(root, target);
  return { target, rel, replaces: hasEnvKey(content, key), git: await gitStateOf(root, rel) };
}

/**
 * For a chat in a linked worktree of `projectPath`, the main checkout's copy of `file` (the one new
 * worktrees copy from), checked like the chat's own; null for any other chat folder.
 */
export async function resolveMainCheckoutTarget(
  cwd: string,
  projectPath: string | null,
  file: string,
  key: string,
): Promise<SecretMainCheckout | null> {
  if (!projectPath) return null;
  // A bare repository has no working tree, so `--show-toplevel` fails and there is no main file.
  const [cwdTop, mainTop] = await Promise.all([repoTopLevel(cwd), repoTopLevel(projectPath)]);
  if (!cwdTop || !mainTop) return null;
  const [realCwd, realCwdTop, realMainTop] = await Promise.all(
    [cwd, cwdTop, mainTop].map(realpathOrNull),
  );
  if (!realCwd || !realCwdTop || !realMainTop || realCwdTop === realMainTop) return null;
  const [cwdCommon, mainCommon] = await Promise.all([gitCommonDir(cwd), gitCommonDir(projectPath)]);
  if ((await realpathOrNull(cwdCommon)) !== (await realpathOrNull(mainCommon))) return null;
  const inRepo = path.relative(realCwdTop, realCwd);
  if (inRepo.split(path.sep).includes('..')) return null;
  const mainDir = path.join(realMainTop, inRepo);
  if (!(await realpathOrNull(path.dirname(path.join(mainDir, file))))) {
    return { skipped: `The folder for ${file} does not exist in your main project.` };
  }
  const target = await resolveSecretTarget(mainDir, file, key).catch((error: unknown) => {
    if (!(error instanceof SecretRequestError)) throw error;
    throw new SecretRequestError(`In your main project: ${error.message}`);
  });
  if (target.git === 'tracked') {
    return { skipped: 'Git tracks that file in your main project, so a commit would include it.' };
  }
  return { path: target.target, replaces: target.replaces, git: target.git };
}
