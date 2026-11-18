import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkBash } from '../check-bash';
import { EMPTY_DOCS, type ScopedDocs } from '../eval-rules';
import type { PermissionsDoc } from '../types';

const none: PermissionsDoc = { allow: [], deny: [], ask: [] };
const userDocs = (doc: Partial<PermissionsDoc>): ScopedDocs => ({
  policy: none,
  project: none,
  user: { ...none, ...doc },
});

let tmp: string;
let session: string;
let project: string;
let p: string;
let other: string;

beforeAll(() => {
  tmp = nodeFs.realpathSync.native(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'sread-')));
  session = nodePath.join(tmp, 'claude-sessions', 'chat-1');
  p = nodePath.join(session, 'pasted');
  other = nodePath.join(tmp, 'claude-sessions', 'chat-2', 'pasted');
  project = nodePath.join(tmp, 'project');
  for (const dir of [p, other, project, nodePath.join(session, 'shell-snapshots')]) {
    nodeFs.mkdirSync(dir, { recursive: true });
  }
  // Attachments arrive by fs.copyFile, as copyIntoPasted makes them.
  const source = nodePath.join(tmp, 'source');
  nodeFs.writeFileSync(source, 'x');
  for (const name of ['a', 'ab12-a b.txt', 'a.pdf', 'b']) {
    nodeFs.copyFileSync(source, nodePath.join(p, name));
  }
  nodeFs.writeFileSync(nodePath.join(other, 'a'), 'x');
  nodeFs.writeFileSync(nodePath.join(session, 'shell-snapshots', 'x.sh'), 'x');
  nodeFs.writeFileSync(nodePath.join(session, '.claude.json'), 'x');
  nodeFs.symlinkSync(nodePath.join(session, 'shell-snapshots', 'x.sh'), nodePath.join(p, 'link'));
  nodeFs.writeFileSync(nodePath.join(p, 'hard'), 'x');
  nodeFs.linkSync(nodePath.join(p, 'hard'), nodePath.join(project, 'hard-twin'));
  nodeFs.mkdirSync(nodePath.join(tmp, 'outside', 'sub'), { recursive: true });
  nodeFs.writeFileSync(nodePath.join(tmp, 'outside', 'a'), 'secret');
  nodeFs.symlinkSync(nodePath.join(tmp, 'outside', 'sub'), nodePath.join(p, 'dirlink'));
  // Bash expands `{..,x}/a` to `../a x/a`, while the literal folder passes a realpath check.
  nodeFs.mkdirSync(nodePath.join(p, '{..,x}'));
  nodeFs.copyFileSync(source, nodePath.join(p, '{..,x}', 'a'));
  // Bash decodes `$'\x2e\x2e'` to `..`, while the parser keeps it as this literal folder name.
  nodeFs.mkdirSync(nodePath.join(p, '$\\x2e\\x2e'));
  nodeFs.copyFileSync(source, nodePath.join(p, '$\\x2e\\x2e', 'a'));
});
afterAll(() => nodeFs.rmSync(tmp, { recursive: true, force: true }));

const run = (command: string, docs: ScopedDocs = EMPTY_DOCS) =>
  checkBash({ command }, docs, project, session).decision;

describe('checkBash: read-only shell reads of the chat attachments folder', () => {
  it.each([
    () => `cat "${p}/ab12-a b.txt"`,
    () => `head -n 5 ${p}/a`,
    () => `tail -n5 ${p}/a`,
    () => `tail -20 ${p}/a ${p}/b`,
    () => `wc -l ${p}/a`,
    () => `file -b ${p}/a.pdf`,
    () => `pdftotext -layout ${p}/a.pdf -`,
    () => `sed -n '1,200p' ${p}/a`,
    () => `cat ${p}/a | grep -n foo`,
    () => `rg -n -- foo ${p}/a`,
    () => `grep -e foo -e bar ${p}/a ${p}/b`,
    () => `xxd -l 64 ${p}/a`,
    () => `grep -E '[0-9]{2}' ${p}/a`,
    () => `cat ${p}/ab12-a\\ b.txt`,
    () => `nl -ba ${p}/a | sed -n '1,40p'`,
  ])('allows %#', (command) => {
    expect(run(command())).toBe('allow');
  });

  it.each([
    ['tail follows', () => `tail -f ${p}/a`],
    ['abbreviated long flag', () => `tail --fol ${p}/a`],
    ['cluster hiding a follow flag', () => `tail -fn5 ${p}/a`],
    ['pdftotext writing a .txt beside it', () => `pdftotext ${p}/a.pdf`],
    ['xxd writing an output file', () => `xxd ${p}/a ${p}/b`],
    ['grep reading patterns from a file', () => `grep -f /etc/hosts ${p}/a`],
    ['a pager', () => `less ${p}/a`],
    ['a sed write script', () => `sed -n '1w x' ${p}/a`],
    ['a flag after a path', () => `cat ${p}/a -n`],
    ['rg with no path', () => 'rg foo'],
    ['a write redirect', () => `cat ${p}/a > ${p}/out`],
    ['a relative path', () => 'cat pasted/a'],
    ["another chat's folder", () => `cat ${other}/a`],
    ['one file outside among inside ones', () => `cat ${p}/a /etc/hosts ${p}/b`],
    ['session scratch outside pasted/', () => `cat ${session}/shell-snapshots/x.sh`],
    ['climbing out of pasted/', () => `cat ${p}/../.claude.json`],
    ['a glob', () => `cat ${p}/*`],
    ['a symlink inside pasted/', () => `cat ${p}/link`],
    ['a file with a second name', () => `cat ${p}/hard`],
    ['a .. after a linked folder', () => `cat ${p}/dirlink/../a`],
    [
      'a value the parser reads as a redirect digit',
      () => `cat ${p}/a && head -c 1 >/dev/null /etc/hosts`,
    ],
    ['a quoted digit before a redirect', () => `cat ${p}/a && head -n "2">&1 /etc/hosts`],
    ['a brace expansion', () => `cat ${p}/{..,x}/a`],
    ['an unquoted bracket glob in the pattern', () => `grep [ab]x ${p}/a`],
    ['ANSI-C quoting that bash decodes to ..', () => `cat ${p}/$'\\x2e\\x2e'/a`],
    ['a missing file', () => `cat ${p}/missing`],
    ['a non-read part first', () => `ln -sf /etc/hosts ${p}/k && cat ${p}/k`],
    ['a backgrounded part', () => `cat ${p}/a & rm x`],
    ['a cd first', () => `cd ${p} && cat a`],
    ['a stdin-only read', () => 'head -n 5'],
    ['an env prefix', () => `LANG=C cat ${p}/a`],
    ['an unquoted Windows path', () => 'cat C:\\Users\\b\\pasted\\a'],
  ])('asks for %s', (_label, command) => {
    expect(run(command())).toBe('ask');
  });

  it('needs the session folder to be passed', () => {
    expect(checkBash({ command: `cat ${p}/a` }, EMPTY_DOCS, project).decision).toBe('ask');
  });

  it("keeps a user's own ask and deny rules", () => {
    expect(run(`cat ${p}/a`, userDocs({ ask: ['Bash(cat:*)'] }))).toBe('ask');
    expect(run(`cat ${p}/a`, userDocs({ deny: ['Bash(cat:*)'] }))).toBe('deny');
  });

  it('keeps a prefix ask rule the exact-match filter drops for a metacharacter word', () => {
    expect(run(`grep '[ab]/x' ${p}/a`, userDocs({ ask: ['Bash(grep:*)'] }))).toBe('ask');
  });
});
