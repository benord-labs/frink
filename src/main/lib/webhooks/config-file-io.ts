import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** The one place the ingress config touches disk, so a test can fake either side of it directly
 * (a real interface) instead of stubbing a Node built-in, which Vitest cannot spy on in ESM. */
export function readConfigFile(target: string): Promise<string> {
  return fs.readFile(target, 'utf-8');
}

/** Written aside and renamed: a rename is atomic, so a reader never catches half a file and takes
 * it for an address this machine was never given. */
export async function writeConfigFile(target: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(`${target}.tmp`, contents, 'utf-8');
  await fs.rename(`${target}.tmp`, target);
}
