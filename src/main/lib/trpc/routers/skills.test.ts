import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanSkillsDirectory } from './skills';

describe('scanSkillsDirectory', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('discovers skills in regular directories', async () => {
    const skillDir = path.join(tmpDir, 'my-skill');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: My Skill\ndescription: A test skill\n---\n# My Skill',
    );

    const skills = await scanSkillsDirectory(tmpDir, 'user');
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('My Skill');
    expect(skills[0].description).toBe('A test skill');
    expect(skills[0].source).toBe('user');
  });

  it('follows symlinked directories to discover skills', async () => {
    // Create real skill directory outside the scan root
    const realDir = path.join(tmpDir, '_real');
    await fs.mkdir(realDir, { recursive: true });
    const realSkillDir = path.join(realDir, 'linked-skill');
    await fs.mkdir(realSkillDir, { recursive: true });
    await fs.writeFile(
      path.join(realSkillDir, 'SKILL.md'),
      '---\nname: Linked Skill\ndescription: Symlinked\n---\n# Linked',
    );

    // Create scan root with a symlink pointing to the real skill dir
    const scanDir = path.join(tmpDir, 'scan');
    await fs.mkdir(scanDir, { recursive: true });
    await fs.symlink(realSkillDir, path.join(scanDir, 'linked-skill'));

    const skills = await scanSkillsDirectory(scanDir, 'user');
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('Linked Skill');
    expect(skills[0].description).toBe('Symlinked');
  });

  it('skips broken symlinks gracefully', async () => {
    // Create a symlink pointing to a nonexistent directory
    const scanDir = path.join(tmpDir, 'scan-broken');
    await fs.mkdir(scanDir, { recursive: true });
    await fs.symlink('/nonexistent/path/that/does/not/exist', path.join(scanDir, 'broken-link'));

    // Should not throw and should return empty
    const skills = await scanSkillsDirectory(scanDir, 'user');
    expect(skills).toHaveLength(0);
  });

  it('skips symlinks pointing to files (not directories)', async () => {
    const scanDir = path.join(tmpDir, 'scan-file-link');
    await fs.mkdir(scanDir, { recursive: true });
    const targetFile = path.join(tmpDir, 'some-file.txt');
    await fs.writeFile(targetFile, 'not a directory');
    await fs.symlink(targetFile, path.join(scanDir, 'file-link'));

    const skills = await scanSkillsDirectory(scanDir, 'user');
    expect(skills).toHaveLength(0);
  });

  it('returns empty array for nonexistent directory', async () => {
    const skills = await scanSkillsDirectory(path.join(tmpDir, 'does-not-exist'), 'user');
    expect(skills).toHaveLength(0);
  });

  it('skips directories without SKILL.md', async () => {
    const noSkill = path.join(tmpDir, 'empty-skill');
    await fs.mkdir(noSkill, { recursive: true });
    await fs.writeFile(path.join(noSkill, 'README.md'), '# Not a skill');

    const skills = await scanSkillsDirectory(tmpDir, 'user');
    expect(skills).toHaveLength(0);
  });

  it('skips entries with path traversal names', async () => {
    const badDir = path.join(tmpDir, '..sneaky');
    await fs.mkdir(badDir, { recursive: true });
    await fs.writeFile(path.join(badDir, 'SKILL.md'), '---\nname: Sneaky\ndescription: bad\n---\n');

    const skills = await scanSkillsDirectory(tmpDir, 'user');
    expect(skills).toHaveLength(0);
  });

  it('uses entry.name as fallback when frontmatter has no name', async () => {
    const skillDir = path.join(tmpDir, 'unnamed-skill');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Just a heading, no frontmatter');

    const skills = await scanSkillsDirectory(tmpDir, 'user');
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('unnamed-skill');
    expect(skills[0].description).toBe('');
  });

  it('skips Frink projected MIRROR copies (.frink-projected marker)', async () => {
    const skillDir = path.join(tmpDir, 'mirrored');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: Mirrored\ndescription: x\n---\n',
    );
    await fs.writeFile(path.join(skillDir, '.frink-projected'), '{}');

    const skills = await scanSkillsDirectory(tmpDir, 'user');
    expect(skills).toHaveLength(0); // a mirror is never a distinct source
  });

  it('flags a frink-shipped skill (.baseline.json) as builtIn', async () => {
    const shipped = path.join(tmpDir, 'frink-flows');
    await fs.mkdir(shipped, { recursive: true });
    await fs.writeFile(
      path.join(shipped, 'SKILL.md'),
      '---\nname: frink-flows\ndescription: x\n---\n',
    );
    await fs.writeFile(path.join(shipped, '.baseline.json'), '{"version":"1"}');
    const plain = path.join(tmpDir, 'mine');
    await fs.mkdir(plain, { recursive: true });
    await fs.writeFile(path.join(plain, 'SKILL.md'), '---\nname: mine\ndescription: y\n---\n');

    const skills = await scanSkillsDirectory(tmpDir, 'user');
    expect(skills.find((s) => s.name === 'frink-flows')?.builtIn).toBe(true);
    expect(skills.find((s) => s.name === 'mine')?.builtIn).toBe(false);
  });

  it('skips Frink internal debris dirs (staging / backup / rejected) even with SKILL.md + baseline', async () => {
    for (const name of [
      'my-skill.staging-123-456',
      'my-skill.old-789',
      'my-skill-0.0.7-rejected',
    ]) {
      const debris = path.join(tmpDir, name);
      await fs.mkdir(debris, { recursive: true });
      await fs.writeFile(path.join(debris, 'SKILL.md'), '---\nname: x\ndescription: x\n---\n');
      await fs.writeFile(path.join(debris, '.baseline.json'), '{}');
    }

    const skills = await scanSkillsDirectory(tmpDir, 'user');
    expect(skills).toHaveLength(0);
  });
});
