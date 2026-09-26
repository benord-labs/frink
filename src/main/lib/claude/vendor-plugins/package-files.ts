import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

/** A declaration that stays inside its package, as it was written and as it resolves on disk. */
async function contained(
  root: string,
  relative: string,
): Promise<{ declared: string; real: string }> {
  const declared = path.resolve(root, relative);
  const lexical = path.relative(path.resolve(root), declared);
  if (path.isAbsolute(relative) || lexical === '..' || lexical.startsWith(`..${path.sep}`)) {
    throw new Error('Plugin declaration escapes its package');
  }
  const [realRoot, real] = await Promise.all([fs.realpath(root), fs.realpath(declared)]);
  if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error('Plugin declaration symlink escapes its package');
  }
  return { declared, real };
}

/** Resolve package declarations only inside their package, including symlink targets. */
export async function containedPluginPath(root: string, relative: string): Promise<string> {
  return (await contained(root, relative)).declared;
}

const pluginJsonSchema = z.json();
export type PluginJson = z.infer<typeof pluginJsonSchema>;

/** An absent optional manifest is allowed; malformed or escaping declarations throw. */
export async function readPluginJson(
  root: string,
  relative: string,
): Promise<PluginJson | undefined> {
  try {
    // Reading the resolved path, not the declared one, closes the gap between the check and the read.
    const { real } = await contained(root, relative);
    return pluginJsonSchema.parse(JSON.parse(await fs.readFile(real, 'utf8')));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      // A dangling symlink is a broken declaration, never an absent manifest.
      const entry = await fs.lstat(path.resolve(root, relative)).catch(() => undefined);
      if (!entry) return undefined;
    }
    throw error;
  }
}

const componentPathsSchema = z.union([z.string().transform((one) => [one]), z.array(z.string())]);
const manifestSchema = z.object({
  skills: componentPathsSchema.optional(),
  commands: componentPathsSchema.optional(),
});

/** Explicit component declarations replace the conventional root, including an empty array. */
export async function pluginComponentPaths(
  root: string,
  kind: 'skills' | 'commands',
): Promise<string[]> {
  const raw = await readPluginJson(root, '.claude-plugin/plugin.json');
  const declared = raw === undefined ? undefined : manifestSchema.parse(raw)[kind];
  return declared ?? [kind];
}
