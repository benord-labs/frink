import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearAgentsMdCache, readAgentsMd } from './read-agents-md';

const tempDirs = new Set<string>();

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frink-agents-md-'));
  tempDirs.add(dir);
  return dir;
}

async function writeAgentsMd(dir: string, content: string): Promise<void> {
  await fs.writeFile(path.join(dir, 'AGENTS.md'), content, 'utf-8');
}

describe('readAgentsMd', () => {
  afterEach(async () => {
    clearAgentsMdCache();
    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  it('returns undefined when AGENTS.md is missing', async () => {
    const dir = await makeTempDir();
    const result = await readAgentsMd(dir);
    expect(result).toBeUndefined();
  });

  it('returns undefined for empty AGENTS.md', async () => {
    const dir = await makeTempDir();
    await writeAgentsMd(dir, '   \n\n');
    const result = await readAgentsMd(dir);
    expect(result).toBeUndefined();
  });

  it('returns undefined when AGENTS.md exceeds size limit', async () => {
    const dir = await makeTempDir();
    await writeAgentsMd(dir, 'x'.repeat(100 * 1024 + 1));
    const result = await readAgentsMd(dir);
    expect(result).toBeUndefined();
  });

  it('returns AGENTS.md content when valid', async () => {
    const dir = await makeTempDir();
    await writeAgentsMd(dir, '# Project instructions\n- Use strict types');
    const result = await readAgentsMd(dir);
    expect(result).toBe('# Project instructions\n- Use strict types');
  });

  it('uses cache to avoid repeat reads within TTL', async () => {
    const dir = await makeTempDir();
    await writeAgentsMd(dir, 'version-1');

    const first = await readAgentsMd(dir);
    expect(first).toBe('version-1');

    await writeAgentsMd(dir, 'version-2');
    const second = await readAgentsMd(dir);
    expect(second).toBe('version-1');
  });

  it('clearAgentsMdCache forces a fresh read', async () => {
    const dir = await makeTempDir();
    await writeAgentsMd(dir, 'version-1');
    const first = await readAgentsMd(dir);
    expect(first).toBe('version-1');

    await writeAgentsMd(dir, 'version-2');
    clearAgentsMdCache();

    const second = await readAgentsMd(dir);
    expect(second).toBe('version-2');
  });
});
