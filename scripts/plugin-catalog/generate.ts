/** Explicit developer command; browsing and ordinary builds never acquire vendor packages. */
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  VENDOR_PLUGIN_PINS,
  type VendorPluginPin,
} from '../../src/shared/integrations/vendor-plugin-pins';
import { vendorPayloadInventory } from '../../src/main/lib/claude/vendor-plugins/inventory';
import {
  containedPluginPath,
  pluginComponentPaths,
  readPluginJson,
} from '../../src/main/lib/claude/vendor-plugins/package-files';

const manifestSchema = z.object({
  skills: z.union([z.string(), z.array(z.string())]).optional(),
});

const outputDir = fileURLToPath(
  new URL('../../src/shared/integrations/vendor-inventory/', import.meta.url),
);

/** The runtime scanner tolerates missing files; generation must fail on unreadable payloads. */
async function verifyReadableTree(directory: string): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await verifyReadableTree(file);
    else if (entry.isFile()) await fs.access(file, fs.constants.R_OK);
  }
}

export async function generateInventory(pin: VendorPluginPin, payload: string) {
  await verifyReadableTree(payload);
  const manifest = manifestSchema.safeParse(
    await readPluginJson(payload, '.claude-plugin/plugin.json'),
  );
  if (!manifest.success) throw new Error(`Missing plugin manifest: ${pin.name}`);
  // Explicit skill roots must exist. The conventional root is legitimately absent in some packages.
  const roots = await pluginComponentPaths(payload, 'skills');
  for (const root of roots) {
    if (manifest.data.skills === undefined && !(await fs.readdir(payload)).includes(root)) continue;
    const directory = await containedPluginPath(payload, root);
    if (!(await fs.stat(directory)).isDirectory()) throw new Error(`Invalid skill root: ${root}`);
    await verifyReadableTree(directory);
  }
  const inventory = await vendorPayloadInventory(pin, payload);
  return {
    pin,
    ...inventory,
    skills: inventory.skills.map((skill) => ({
      ...skill,
      path: path.relative(payload, skill.path).split(path.sep).join('/'),
    })),
    commands: inventory.commands.sort(),
  };
}

const exec = promisify(execFile);

/** Extract the immutable source revision; never read an edited worktree or enable the plugin. */
async function pinnedPayload(pin: VendorPluginPin, acquire: boolean, scratch: string) {
  const repository = path.join(os.homedir(), '.cache', 'frink-plugin-catalog', pin.payloadRepo);
  if (acquire) {
    await fs.mkdir(repository, { recursive: true });
    await exec('git', ['init', '--bare', repository]);
    await exec('git', [
      '-C',
      repository,
      'fetch',
      '--depth=1',
      `https://github.com/${pin.payloadRepo}.git`,
      pin.gitCommitSha,
    ]);
  }
  await exec('git', ['-C', repository, 'cat-file', '-e', `${pin.gitCommitSha}^{commit}`]);
  const archive = path.join(scratch, `${pin.name}.tar`);
  const payload = path.join(scratch, pin.name);
  await fs.mkdir(payload);
  await exec('git', [
    '-C',
    repository,
    'archive',
    '--format=tar',
    `--output=${archive}`,
    `${pin.gitCommitSha}${pin.payloadPath ? `:${pin.payloadPath}` : ''}`,
  ]);
  await exec('tar', ['-xf', archive, '-C', payload]);
  return payload;
}

async function main() {
  const check = process.argv.includes('--check');
  const acquire = process.argv.includes('--acquire');
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'frink-plugin-catalog-'));
  const outputs: Array<{ name: string; json: string }> = [];
  try {
    for (const [id, pin] of Object.entries(VENDOR_PLUGIN_PINS)) {
      const payload = await pinnedPayload(pin, acquire, scratch);
      const inventory = await generateInventory(pin, payload);
      outputs.push({ name: `${id}.json`, json: `${JSON.stringify(inventory, null, 2)}\n` });
      console.log(
        `${id}: ${inventory.skills.length} skills, ${inventory.commands.length} commands`,
      );
    }
    // Validate every package before replacing any committed output.
    for (const output of outputs) {
      const file = path.join(outputDir, output.name);
      if (check) {
        if (
          JSON.stringify(JSON.parse(await fs.readFile(file, 'utf8'))) !==
          JSON.stringify(JSON.parse(output.json))
        )
          throw new Error(`Stale inventory: ${output.name}`);
      } else await fs.writeFile(file, output.json);
    }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
