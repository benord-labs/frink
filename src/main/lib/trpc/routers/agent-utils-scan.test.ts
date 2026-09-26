import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanAgentsDirectory } from './agent-utils';

describe('scanAgentsDirectory — Frink mirror exclusion', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agents-scan-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('skips a projected mirror agent via RAW frinkProjected frontmatter (parseAgentMd strips it)', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'mirror.md'),
      '---\nname: mirror\ndescription: a mirror\nfrinkProjected: true\n---\nbody',
    );
    await fs.writeFile(
      path.join(tmpDir, 'origin.md'),
      '---\nname: origin\ndescription: the origin\n---\nbody',
    );

    const agents = await scanAgentsDirectory(tmpDir, 'user');
    expect(agents.map((a) => a.name)).toEqual(['origin']);
  });
});
