import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { splitCommand } from '../bash-parser';
import { hasEscapingRedirect, type RedirectRoots } from './index';

let sandbox: string;
let project: string;
let worktree: string;
let sibling: string;
beforeAll(() => {
  sandbox = nodeFs.mkdtempSync(nodePath.join(nodeOs.homedir(), '.frink-redirect-test-'));
  project = nodePath.join(sandbox, 'project');
  worktree = nodePath.join(sandbox, 'worktrees', 'one');
  sibling = nodePath.join(sandbox, 'worktrees', 'two');
  for (const dir of [project, worktree, sibling]) nodeFs.mkdirSync(dir, { recursive: true });
});
afterAll(() => nodeFs.rmSync(sandbox, { recursive: true, force: true }));

function escapes(command: string, roots: Partial<RedirectRoots> = {}): boolean {
  const [sub] = splitCommand(command);
  return hasEscapingRedirect(sub, { projectRoot: project, ...roots });
}

describe('hasEscapingRedirect — operators', () => {
  it('asks for every output operator aimed outside the project', () => {
    for (const op of ['>', '>>', '2>', '&>', '&>>', '>&', '1<>']) {
      expect(escapes(`echo x ${op} ~/.zshrc`), op).toBe(true);
    }
  });

  it('ignores input redirects and file-descriptor duplication', () => {
    for (const command of [
      'cat < ~/.zshrc',
      'cat <<< hello',
      'npm test 2>&1',
      'echo x >&2',
      'echo x 1>&2',
      'echo x >&-',
    ]) {
      expect(escapes(command), command).toBe(false);
    }
  });

  it('never asks for the output sinks', () => {
    for (const sink of ['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty', '/dev/fd/3']) {
      expect(escapes(`echo x > ${sink}`), sink).toBe(false);
    }
  });

  it('asks for other device files', () => {
    expect(escapes('echo x > /dev/tcp/example.com/80')).toBe(true);
  });

  it('asks when the target cannot be read', () => {
    // A glob target and the `>|` split both leave a bare operator.
    expect(escapes('echo x > ~/.zsh*')).toBe(true);
    expect(escapes('echo x >')).toBe(true);
    expect(escapes('echo x > {a,b}.txt')).toBe(true);
    expect(escapes('echo x > src/[ab].txt')).toBe(true);
    // ANSI-C quoting: shell-quote keeps the escapes literal, bash decodes `\x2f` to `/`.
    expect(escapes("echo x > $'\\x2fetc/hosts'")).toBe(true);
    // `$'…'` and `$"…"` quoting reaches the parser as a literal `$` the shell would drop.
    expect(escapes("echo x > $'/etc/hosts'")).toBe(true);
    expect(escapes('echo x > $"/etc/hosts"')).toBe(true);
  });

  it('finds no redirect in quoted or commented text', () => {
    expect(escapes("echo 'x >> ~/.zshrc'")).toBe(false);
    expect(escapes('echo "x > ~/.zshrc"')).toBe(false);
    expect(escapes('echo x # > ~/.zshrc')).toBe(false);
  });
});

describe('hasEscapingRedirect — targets', () => {
  it('allows targets inside the project, absolute or relative', () => {
    expect(escapes('echo x > out.txt')).toBe(false);
    expect(escapes('echo x > src/new/out.txt')).toBe(false);
    expect(escapes(`echo x > ${nodePath.join(project, 'out.txt')}`)).toBe(false);
  });

  it('asks for targets outside the project', () => {
    expect(escapes('echo x > ../out.txt')).toBe(true);
    expect(escapes('echo x > src/../../out.txt')).toBe(true);
    expect(escapes(`echo x > ${nodePath.join(sandbox, 'out.txt')}`)).toBe(true);
    expect(escapes('echo x > /etc/hosts')).toBe(true);
  });

  it('asks for a ~ target even when it expands into the project', () => {
    const insideViaHome = `~/${nodePath.relative(nodeOs.homedir(), project)}/out.txt`;
    expect(escapes(`echo x > ${insideViaHome}`)).toBe(true);
  });

  it('counts the execution folder as inside, and a sibling worktree as outside', () => {
    const roots = { executionRoot: worktree };
    expect(escapes(`echo x > ${nodePath.join(worktree, 'out.txt')}`, roots)).toBe(false);
    expect(escapes('echo x > out.txt', roots)).toBe(false);
    expect(escapes(`echo x > ${nodePath.join(sibling, 'out.txt')}`, roots)).toBe(true);
    expect(escapes(`echo x > ${nodePath.join(worktree, 'out.txt')}`)).toBe(true);
  });

  it('asks for a relative target when there is no root to resolve it against', () => {
    expect(escapes('echo x > out.txt', { projectRoot: '' })).toBe(true);
  });
});

describe('hasEscapingRedirect — temp folders and links', () => {
  it('allows a new file in the temp folders', () => {
    const name = `frink-redirect-${process.pid}-${Date.now()}.log`;
    expect(escapes(`npm test > ${nodePath.join(nodeOs.tmpdir(), name)} 2>&1`)).toBe(false);
    expect(escapes(`npm test > /tmp/${name}`)).toBe(false);
    expect(escapes(`npm test > /var/tmp/${name}`)).toBe(false);
  });

  it('asks for a link in the temp folder that points outside it', () => {
    const outside = nodePath.join(sandbox, 'target.txt');
    nodeFs.writeFileSync(outside, '');
    const temp = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'frink-redirect-'));
    try {
      nodeFs.symlinkSync(outside, nodePath.join(temp, 'link'));
      nodeFs.symlinkSync(nodePath.join(sandbox, 'missing.txt'), nodePath.join(temp, 'dangling'));
      expect(escapes(`echo x > ${nodePath.join(temp, 'link')}`)).toBe(true);
      expect(escapes(`echo x > ${nodePath.join(temp, 'dangling')}`)).toBe(true);
    } finally {
      nodeFs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it('matches a project reached through a link, however the target is spelled', () => {
    const viaLink = nodePath.join(sandbox, 'project-link');
    nodeFs.symlinkSync(project, viaLink);
    expect(escapes(`echo x > ${nodePath.join(project, 'a.txt')}`, { projectRoot: viaLink })).toBe(
      false,
    );
    expect(escapes(`echo x > ${nodePath.join(viaLink, 'a.txt')}`)).toBe(false);
  });

  it('follows a link inside the project to where it points', () => {
    nodeFs.symlinkSync(sandbox, nodePath.join(project, 'up'));
    expect(escapes('echo x > up/out.txt')).toBe(true);
  });
});

describe('hasEscapingRedirect — targets the shell resolves differently from the text', () => {
  it('asks instead of throwing for a target it cannot inspect', () => {
    nodeFs.writeFileSync(nodePath.join(project, 'README.md'), '');
    expect(escapes('echo x > README.md/out.txt')).toBe(true);
    const locked = nodePath.join(project, 'locked');
    nodeFs.mkdirSync(nodePath.join(locked, 'inner'), { recursive: true });
    nodeFs.chmodSync(locked, 0o000);
    try {
      expect(escapes('echo x > locked/inner/out.txt')).toBe(true);
    } finally {
      nodeFs.chmodSync(locked, 0o755);
    }
  });

  it('follows a link before a `..` after it, as the shell does', () => {
    const outside = nodePath.join(sandbox, 'elsewhere', 'deep');
    nodeFs.mkdirSync(outside, { recursive: true });
    nodeFs.symlinkSync(outside, nodePath.join(project, 'jump'));
    expect(escapes('echo x > jump/../out.txt')).toBe(true);
    const temp = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'frink-redirect-'));
    try {
      nodeFs.symlinkSync(outside, nodePath.join(temp, 'link'));
      expect(escapes(`echo x > ${nodePath.join(temp, 'link')}/../x`)).toBe(true);
    } finally {
      nodeFs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it('still allows a plain `..` that stays inside the project', () => {
    nodeFs.mkdirSync(nodePath.join(project, 'pkg'), { recursive: true });
    expect(escapes('echo x > pkg/../out.txt')).toBe(false);
    expect(escapes('echo x > ../out.txt', { cwd: nodePath.join(project, 'pkg') })).toBe(false);
  });
});
