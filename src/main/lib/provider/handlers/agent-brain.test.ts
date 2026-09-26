import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import matter from 'gray-matter';
import { parse as parseToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CODEX_PROJECTED_MARKER, deliverAgentBrain } from './agent-brain';
import { mockHome } from './test-mock-home';

vi.mock('node:os', async (importOriginal) =>
  (await import('./test-mock-home')).osModuleWithMockHome(importOriginal),
);
vi.mock('electron-log', async () => (await import('./test-mock-home')).electronLogMock());

const ctx = { projectId: 'p', projectPath: '/p', provider: 'claude-code' as const };

const CLAUDE_AGENT = `---
name: security-auditor
description: Reads code for security issues
model: opus
tools: Read, Grep
color: red
---

Audit the code. Never edit files.
`;

describe('deliverAgentBrain (PCH-4)', () => {
  let tmp: string;
  const claudeDir = () => path.join(tmp, '.claude', 'agents');
  const cursorDir = () => path.join(tmp, '.cursor', 'agents');
  const codexDir = () => path.join(tmp, '.codex', 'agents');
  const frinkDir = () => path.join(tmp, '.frink', 'agents');

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pch4-agents-'));
    mockHome.value = tmp;
    await fs.mkdir(claudeDir(), { recursive: true });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('projects a claude agent to cursor + frink dirs — body verbatim, unknown keys kept, stamped', async () => {
    await fs.writeFile(path.join(claudeDir(), 'auditor.md'), CLAUDE_AGENT);
    const res = await deliverAgentBrain({ mode: 'copy', ctx });
    expect(res.status).toBe('delivered');
    for (const dir of [cursorDir(), frinkDir()]) {
      const projected = matter(await fs.readFile(path.join(dir, 'auditor.md'), 'utf-8'));
      expect(projected.content.trim()).toBe('Audit the code. Never edit files.');
      expect(projected.data.name).toBe('security-auditor');
      expect(projected.data.color).toBe('red'); // unknown key preserved (verbatim)
      expect(projected.data.frinkProjected).toBe(true);
    }
  });

  it('omits model/tools cross-family (→ cursor) but keeps them same-family (→ frink)', async () => {
    await fs.writeFile(path.join(claudeDir(), 'auditor.md'), CLAUDE_AGENT);
    await deliverAgentBrain({ mode: 'copy', ctx });
    const toCursor = matter(await fs.readFile(path.join(cursorDir(), 'auditor.md'), 'utf-8'));
    expect(toCursor.data.model).toBeUndefined(); // 'opus' is not a Cursor model id
    expect(toCursor.data.tools).toBeUndefined(); // Claude tool names don't translate
    const toFrink = matter(await fs.readFile(path.join(frinkDir(), 'auditor.md'), 'utf-8'));
    expect(toFrink.data.model).toBe('opus'); // .frink is Claude-flavored — kept
    expect(toFrink.data.tools).toBe('Read, Grep');
  });

  describe('codex role files', () => {
    const readRole = async (file: string) => {
      const text = await fs.readFile(path.join(codexDir(), file), 'utf-8');
      expect(text.startsWith(`${CODEX_PROJECTED_MARKER}\n`)).toBe(true);
      return parseToml(text);
    };

    it('writes <stem>.toml with only keys Codex role files accept; read-only maps to the sandbox', async () => {
      await fs.writeFile(path.join(claudeDir(), 'auditor.md'), CLAUDE_AGENT);
      await deliverAgentBrain({ mode: 'copy', ctx });
      expect(existsSync(path.join(codexDir(), 'auditor.md'))).toBe(false);
      expect(await readRole('auditor.toml')).toEqual({
        name: 'security-auditor',
        description: 'Reads code for security issues',
        sandbox_mode: 'read-only', // tools: Read, Grep
        developer_instructions: 'Audit the code. Never edit files.',
      });
    });

    it('leaves an unrestricted agent on the default sandbox', async () => {
      await fs.writeFile(
        path.join(claudeDir(), 'free.md'),
        '---\nname: free\ndescription: Does anything\n---\n\nNo limits.\n',
      );
      await deliverAgentBrain({ mode: 'copy', ctx });
      expect(await readRole('free.toml')).toEqual({
        name: 'free',
        description: 'Does anything',
        developer_instructions: 'No limits.',
      });
    });

    it('refuses limits Codex cannot enforce and removes an earlier mirror of that agent', async () => {
      await fs.writeFile(
        path.join(claudeDir(), 'writer.md'),
        '---\nname: writer\ndescription: d\n---\n\nBody.\n',
      );
      await deliverAgentBrain({ mode: 'copy', ctx });
      expect(existsSync(path.join(codexDir(), 'writer.toml'))).toBe(true);
      await fs.writeFile(
        path.join(claudeDir(), 'writer.md'),
        '---\nname: writer\ndescription: d\ntools: Read, Bash\n---\n\nBody.\n',
      );
      await deliverAgentBrain({ mode: 'copy', ctx });
      expect(existsSync(path.join(codexDir(), 'writer.toml'))).toBe(false);
    });

    it('skips agents Codex would reject (no description)', async () => {
      await fs.writeFile(path.join(claudeDir(), 'bare.md'), '---\nname: bare\n---\n\nBody.\n');
      await deliverAgentBrain({ mode: 'copy', ctx });
      expect(existsSync(path.join(codexDir(), 'bare.toml'))).toBe(false);
    });

    it('never clobbers a role file Frink did not write', async () => {
      await fs.writeFile(path.join(claudeDir(), 'auditor.md'), CLAUDE_AGENT);
      await fs.mkdir(codexDir(), { recursive: true });
      const own = 'name = "auditor"\ndescription = "mine"\ndeveloper_instructions = "Mine."\n';
      await fs.writeFile(path.join(codexDir(), 'auditor.toml'), own);
      await deliverAgentBrain({ mode: 'copy', ctx });
      expect(await fs.readFile(path.join(codexDir(), 'auditor.toml'), 'utf-8')).toBe(own);
    });

    it('deletes stamped .md mirrors left in the codex dir and keeps user-authored ones', async () => {
      await fs.mkdir(codexDir(), { recursive: true });
      await fs.writeFile(
        path.join(codexDir(), 'old.md'),
        '---\nname: old\nfrinkProjected: true\n---\n\nx\n',
      );
      await fs.writeFile(path.join(codexDir(), 'notes.md'), '---\nname: notes\n---\n\nmine\n');
      await deliverAgentBrain({ mode: 'copy', ctx });
      expect(existsSync(path.join(codexDir(), 'old.md'))).toBe(false);
      expect(existsSync(path.join(codexDir(), 'notes.md'))).toBe(true);
      // A .md in the codex dir is not an agent source: nothing is projected from it.
      expect(existsSync(path.join(frinkDir(), 'notes.md'))).toBe(false);
    });
  });

  // PCH-5: a read-only-by-declaration agent degrades to Cursor's coarse native switch.
  it('stamps readonly:true on the cursor projection when every declared tool is read-class', async () => {
    await fs.writeFile(path.join(claudeDir(), 'auditor.md'), CLAUDE_AGENT); // tools: Read, Grep
    await deliverAgentBrain({ mode: 'copy', ctx });
    const toCursor = matter(await fs.readFile(path.join(cursorDir(), 'auditor.md'), 'utf-8'));
    expect(toCursor.data.readonly).toBe(true);
    // Same-family targets never gain the cursor-only flag.
    const toFrink = matter(await fs.readFile(path.join(frinkDir(), 'auditor.md'), 'utf-8'));
    expect(toFrink.data.readonly).toBeUndefined();
  });

  it('never stamps readonly for write-capable, unknown-tool, or unrestricted agents', async () => {
    await fs.writeFile(
      path.join(claudeDir(), 'writer.md'),
      '---\nname: writer\ntools: Read, Bash\n---\n\nCan run commands.\n',
    );
    await fs.writeFile(
      path.join(claudeDir(), 'oddball.md'),
      '---\nname: oddball\ntools: Read, SomeUnknownTool\n---\n\nUnknown tool listed.\n',
    );
    await fs.writeFile(
      path.join(claudeDir(), 'free.md'),
      '---\nname: free\n---\n\nNo tools field at all.\n',
    );
    await deliverAgentBrain({ mode: 'copy', ctx });
    for (const f of ['writer.md', 'oddball.md', 'free.md']) {
      const projected = matter(await fs.readFile(path.join(cursorDir(), f), 'utf-8'));
      expect(projected.data.readonly).toBeUndefined();
    }
  });

  it('a multiline quoted description survives re-stringify parse-equivalently', async () => {
    const src = matter.stringify('Body text.\n', {
      name: 'multi',
      description: 'Line one: with colon\nLine two "quoted" text',
    });
    await fs.writeFile(path.join(claudeDir(), 'multi.md'), src);
    await deliverAgentBrain({ mode: 'copy', ctx });
    const projected = matter(await fs.readFile(path.join(cursorDir(), 'multi.md'), 'utf-8'));
    expect(projected.data.description).toBe('Line one: with colon\nLine two "quoted" text');
    expect(projected.content.trim()).toBe('Body text.');
  });

  it('excludes stamped projections from the source set (no amplification)', async () => {
    await fs.writeFile(path.join(claudeDir(), 'auditor.md'), CLAUDE_AGENT);
    await deliverAgentBrain({ mode: 'copy', ctx });
    // Remove the original — only the stamped mirrors remain.
    await fs.rm(path.join(claudeDir(), 'auditor.md'));
    const res = await deliverAgentBrain({ mode: 'copy', ctx });
    expect(res.detail).toContain('0 agent(s)'); // mirrors never become sources
    expect(existsSync(path.join(claudeDir(), 'auditor.md'))).toBe(false);
  });

  it('never clobbers a user-authored agent of the same filename at a target', async () => {
    await fs.writeFile(path.join(claudeDir(), 'auditor.md'), CLAUDE_AGENT);
    await fs.mkdir(cursorDir(), { recursive: true });
    await fs.writeFile(
      path.join(cursorDir(), 'auditor.md'),
      '---\nname: my-own-auditor\n---\n\nMy own cursor agent.\n',
    );
    await deliverAgentBrain({ mode: 'copy', ctx });
    const kept = await fs.readFile(path.join(cursorDir(), 'auditor.md'), 'utf-8');
    expect(kept).toContain('My own cursor agent.');
    expect(matter(kept).data.frinkProjected).toBeUndefined();
  });

  it('overwrites an edited MIRROR on the next delivery (intentional mirror semantics)', async () => {
    await fs.writeFile(path.join(claudeDir(), 'auditor.md'), CLAUDE_AGENT);
    await deliverAgentBrain({ mode: 'copy', ctx });
    const mirror = path.join(cursorDir(), 'auditor.md');
    // User edits the stamped mirror (keeping the stamp) instead of the source.
    const edited = matter(await fs.readFile(mirror, 'utf-8'));
    await fs.writeFile(mirror, matter.stringify('EDITED MIRROR\n', edited.data));
    await deliverAgentBrain({ mode: 'copy', ctx });
    expect(await fs.readFile(mirror, 'utf-8')).not.toContain('EDITED MIRROR');
  });

  it('skips the write when the mirror is already identical (no per-spawn churn)', async () => {
    await fs.writeFile(path.join(claudeDir(), 'auditor.md'), CLAUDE_AGENT);
    const first = await deliverAgentBrain({ mode: 'copy', ctx });
    // One claude source fans out to the three OTHER dirs: cursor + codex + frink.
    expect(first.detail).toContain('3 write(s)');
    const second = await deliverAgentBrain({ mode: 'copy', ctx });
    expect(second.detail).toContain('0 write(s)');
  });

  it('dedups by frontmatter name across dirs; divergent same-name user agents are not merged', async () => {
    // Same frontmatter name in two dirs under DIFFERENT filenames → one source (first dir wins).
    await fs.writeFile(path.join(claudeDir(), 'auditor.md'), CLAUDE_AGENT);
    await fs.mkdir(cursorDir(), { recursive: true });
    await fs.writeFile(
      path.join(cursorDir(), 'sec.md'),
      '---\nname: security-auditor\n---\n\nDifferent cursor take.\n',
    );
    await deliverAgentBrain({ mode: 'copy', ctx });
    // The cursor-authored file is untouched (no merge, no clobber)…
    expect(await fs.readFile(path.join(cursorDir(), 'sec.md'), 'utf-8')).toContain(
      'Different cursor take.',
    );
    // …and only ONE source (the .claude one) was projected.
    expect(existsSync(path.join(frinkDir(), 'auditor.md'))).toBe(true);
    expect(existsSync(path.join(frinkDir(), 'sec.md'))).toBe(false);
  });
});
