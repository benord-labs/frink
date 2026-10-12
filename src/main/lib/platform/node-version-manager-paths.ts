import * as path from 'node:path';

/** Fallback PATH entries for the Node.js version managers other than nvm. Reads no disk.
 * mise and asdf go last: their shims exit non-zero when no global version is set. */
export function nodeVersionManagerPaths(home: string, platform: 'darwin' | 'linux'): string[] {
  // fnm keeps `aliases/default` as a symlink to the installed version, so its bin dir is a
  // fixed path. Base dirs are listed in the order fnm itself looks for them.
  const fnmDirs = [path.join(home, '.local', 'share', 'fnm'), path.join(home, '.fnm')];
  if (platform === 'darwin') {
    fnmDirs.push(path.join(home, 'Library', 'Application Support', 'fnm'));
  }

  return [
    ...fnmDirs.map((dir) => path.join(dir, 'aliases', 'default', 'bin')),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.local', 'share', 'mise', 'shims'),
    path.join(home, '.asdf', 'shims'),
    // asdf's shims run a bare `asdf`, which a git-clone install keeps here.
    path.join(home, '.asdf', 'bin'),
  ];
}
