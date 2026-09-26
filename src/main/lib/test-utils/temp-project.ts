import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';

type TempDirRegistry = {
  track: (dir: string) => void;
  cleanup: () => Promise<void>;
};

export function createTempDirRegistry(): TempDirRegistry {
  const tempDirs: string[] = [];

  return {
    track: (dir: string) => {
      tempDirs.push(dir);
    },
    cleanup: async () => {
      await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
      tempDirs.length = 0;
    },
  };
}

export async function createTempProjectFile(
  registry: TempDirRegistry,
  prefix: string,
  relativeFilePath: string,
  content: string,
): Promise<{ root: string; filePath: string }> {
  const root = await mkdtemp(nodePath.join(nodeOs.tmpdir(), prefix));
  registry.track(root);
  const filePath = nodePath.join(root, relativeFilePath);
  await mkdir(nodePath.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  return { root, filePath };
}
