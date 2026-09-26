/**
 * Filesystem discovery + IO for slash-commands (Claude / Cursor / Frink / staged vendor plugins).
 *
 * Single home for command file scanning, name resolution, and reads so both the
 * `commands` tRPC router (renderer-facing) and the flows MCP tools (agent-facing
 * `frink_flows_patch` expansion + `frink_flows_list_catalog` kind:commands) share one implementation.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import log from 'electron-log';
import matter from 'gray-matter';
import type { VendorPluginPin } from '../../../shared/integrations/vendor-plugin-pins';
import { readVettedStagedPlugins } from '../claude/vendor-plugins';
import { canonicalPayloadDir } from '../claude/vendor-plugins/layout';
import { containedPluginPath, pluginComponentPaths } from '../claude/vendor-plugins/package-files';
import { frinkUserHome } from '../platform/frink-home';
import { captureContained } from '../sentry';

/** `plugin` = a staged vendor package's read-only template, named `<plugin>:<stem>` like claude-code does. */
type CommandOrigin = 'frink' | 'claude' | 'cursor' | 'plugin';

export type FileCommand = {
  name: string;
  description: string;
  argumentHint?: string;
  /** The body consumes $ARGUMENTS, so text typed after the command changes the prompt. */
  takesArguments: boolean;
  source: 'user' | 'project';
  origin: CommandOrigin;
  path: string;
};

const MD_SUFFIX_REGEX = /\.md$/;
const COMMANDS_SEP = `${path.sep}commands${path.sep}`;

/** Read description and argument-hint from frontmatter, and the $ARGUMENTS marker from the body. */
function parseCommandMd(content: string) {
  try {
    const { data, content: body } = matter(content);
    return {
      description: typeof data.description === 'string' ? data.description : undefined,
      argumentHint: typeof data['argument-hint'] === 'string' ? data['argument-hint'] : undefined,
      takesArguments: body.includes('$ARGUMENTS'),
    };
  } catch (err) {
    // getCommandContent reads the same file back as '' on this failure, so nothing can consume args.
    captureContained(err, { surface: 'command-md-parse' });
    return { description: undefined, argumentHint: undefined, takesArguments: false };
  }
}

/** Validate entry name for security (prevent path traversal). */
function isValidEntryName(name: string): boolean {
  return !name.includes('..') && !name.includes('/') && !name.includes('\\');
}

/**
 * Extract the commands root directory from a file path.
 * e.g. "/home/user/.frink/commands/git/commit.md" → "/home/user/.frink/commands"
 * Returns null if path doesn't contain a `/commands/` segment.
 * Uses lastIndexOf to find the innermost `/commands/` segment, preventing
 * a crafted prefix (e.g. `/evil/commands/.../.frink/commands/`) from misleading the result.
 */
export function getCommandsRoot(filePath: string): string | null {
  const cmdIdx = filePath.lastIndexOf(COMMANDS_SEP);
  if (cmdIdx === -1) return null;
  return filePath.substring(0, cmdIdx + COMMANDS_SEP.length - 1);
}

/** A namespaced command name `git:commit` → relative path `git/commit` (no extension). */
export function commandNameToRelPath(name: string): string {
  return name.split(':').join(path.sep);
}

/** Security check: ensure a path is inside any known commands directory (.frink, .claude, or .cursor) (follows symlinks). */
export async function isCommandPath(filePath: string): Promise<boolean> {
  try {
    const real = await fs.realpath(filePath);
    return (
      real.includes(`${path.sep}.frink${path.sep}commands${path.sep}`) ||
      real.includes(`${path.sep}.claude${path.sep}commands${path.sep}`) ||
      real.includes(`${path.sep}.cursor${path.sep}commands${path.sep}`)
    );
  } catch {
    log.warn(`[Commands] realpath failed for path check, falling back to resolve-only`);
    const resolved = path.resolve(filePath);
    return (
      resolved.includes(`${path.sep}.frink${path.sep}commands${path.sep}`) ||
      resolved.includes(`${path.sep}.claude${path.sep}commands${path.sep}`) ||
      resolved.includes(`${path.sep}.cursor${path.sep}commands${path.sep}`)
    );
  }
}

/** The pins with a vetted staged entry; every plugin path below derives from the pin, not the manifest. */
async function vettedStagedPlugins(): Promise<VendorPluginPin[]> {
  return (await readVettedStagedPlugins()).map((vetted) => vetted.pin);
}

/**
 * The payload's `commands/` dir, realpath'd — null when absent or when it resolves OUTSIDE the
 * payload, so a symlinked commands root can never make external files scannable or readable.
 */
async function pluginCommandsRoot(
  plugin: VendorPluginPin,
  payloadDir = canonicalPayloadDir(plugin),
): Promise<string | null> {
  try {
    const payload = await fs.realpath(payloadDir);
    const root = await fs.realpath(path.join(payloadDir, 'commands'));
    return root.startsWith(`${payload}${path.sep}`) ? root : null;
  } catch {
    return null;
  }
}

/** A vetted payload's commands, named `<prefix>:<stem>`; the one enumerator the grid and dropdown share. */
export async function scanPluginPayloadCommands(
  plugin: VendorPluginPin,
  prefix: string,
  payloadDir = canonicalPayloadDir(plugin),
): Promise<FileCommand[]> {
  // Containment is judged on the realpath; the scan walks the canonical path so recorded paths match it.
  if (!(await pluginCommandsRoot(plugin, payloadDir))) return [];
  const commandsDir = path.join(payloadDir, 'commands');
  const declarations = await pluginComponentPaths(payloadDir, 'commands');
  const roots = await Promise.all(
    declarations.map((root) => containedPluginPath(payloadDir, root)),
  );
  const commands = await scanCommandsDirectory(commandsDir, 'user', 'plugin', prefix);
  return commands.filter((command) =>
    roots.some((root) => command.path === root || command.path.startsWith(root + path.sep)),
  );
}

/**
 * True when `filePath` is a regular `.md` file inside a vetted plugin's `commands/` dir — the set the
 * scanner lists. Both sides are realpath'd (symlinked $HOME) and any fs failure fails closed.
 */
async function isPluginCommandPath(filePath: string): Promise<boolean> {
  let real: string;
  try {
    real = await fs.realpath(filePath);
    if (!real.endsWith('.md') || !(await fs.stat(real)).isFile()) return false;
  } catch {
    return false;
  }
  for (const plugin of await vettedStagedPlugins()) {
    const root = await pluginCommandsRoot(plugin);
    if (root && real.startsWith(`${root}${path.sep}`)) return true;
  }
  return false;
}

/**
 * Read gate: everything isCommandPath admits plus the read-only vendor plugin store. The trpc
 * update/delete mutations keep isCommandPath, so a vendor template can never be edited or removed.
 */
export async function isReadableCommandPath(filePath: string): Promise<boolean> {
  return (await isCommandPath(filePath)) || (await isPluginCommandPath(filePath));
}

/**
 * Best-effort cleanup of empty ancestor directories up to (but not including) `stopAt`.
 * Used after rename/delete to remove leftover namespace directories like `git/` when empty.
 */
export async function cleanEmptyAncestors(dirPath: string, stopAt: string): Promise<void> {
  let current = dirPath;
  while (current !== stopAt && current.startsWith(`${stopAt}${path.sep}`)) {
    try {
      await fs.rmdir(current); // Only succeeds if directory is empty
      current = path.dirname(current);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code && code !== 'ENOTEMPTY' && code !== 'ENOENT') {
        log.debug(`cleanEmptyAncestors: failed to remove ${current} (${code})`);
      }
      break;
    }
  }
}

/** Build a .md file string with gray-matter frontmatter. */
export function buildCommandMd(opts: { description?: string; content: string }): string {
  const frontmatter: Record<string, string> = {};
  if (opts.description) frontmatter.description = opts.description;

  if (Object.keys(frontmatter).length === 0) {
    return opts.content;
  }

  // Normalize trailing whitespace — matter.stringify may add extra newlines
  return `${matter.stringify(opts.content, frontmatter).trimEnd()}\n`;
}

/** Recursively scan a directory for .md command files (git/commit.md → git:commit). */
async function scanCommandsDirectory(
  dir: string,
  source: 'user' | 'project',
  origin: CommandOrigin,
  prefix = '',
  ctx?: { rootReal: string; visited: Set<string> },
): Promise<FileCommand[]> {
  const commands: FileCommand[] = [];

  try {
    // Resolve real path for cycle detection and containment checks
    let realDir: string;
    try {
      realDir = await fs.realpath(dir);
    } catch {
      return commands;
    }

    // First call: establish the root boundary for symlink containment
    const { rootReal, visited } = ctx ?? { rootReal: realDir, visited: new Set<string>() };

    if (visited.has(realDir)) return commands;
    visited.add(realDir);

    // Containment: reject directories that resolve outside the scan root
    if (realDir !== rootReal && !realDir.startsWith(`${rootReal}${path.sep}`)) {
      log.warn(`[Commands] Skipping symlink escape: ${dir} resolves outside root`);
      return commands;
    }

    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (!isValidEntryName(entry.name)) {
        continue;
      }

      const fullPath = path.join(dir, entry.name);

      // Symlinks report isDirectory()=false and isFile()=false, so resolve via fs.stat
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const realTarget = await fs.realpath(fullPath);
          // Containment: symlink target must stay within the scan root
          if (!realTarget.startsWith(`${rootReal}${path.sep}`) && realTarget !== rootReal) {
            continue;
          }
          const stat = await fs.stat(fullPath);
          isDir = stat.isDirectory();
          isFile = stat.isFile();
        } catch {
          // Broken symlink — skip
          continue;
        }
      }

      if (isDir) {
        // Recursively scan nested directories (pass context for cycle + containment checks)
        const nestedCommands = await scanCommandsDirectory(
          fullPath,
          source,
          origin,
          prefix ? `${prefix}:${entry.name}` : entry.name,
          { rootReal, visited },
        );
        commands.push(...nestedCommands);
      } else if (isFile && entry.name.endsWith('.md')) {
        const baseName = entry.name.replace(MD_SUFFIX_REGEX, '');
        const commandName = prefix ? `${prefix}:${baseName}` : baseName;

        try {
          const content = await fs.readFile(fullPath, 'utf-8');
          const parsed = parseCommandMd(content);

          commands.push({
            name: commandName,
            description: parsed.description || '',
            argumentHint: parsed.argumentHint,
            takesArguments: parsed.takesArguments,
            source,
            origin,
            path: fullPath,
          });
        } catch (err) {
          log.warn(`[Commands] Failed to read command file ${fullPath}:`, err);
        }
      }
    }
  } catch (err) {
    log.warn(`[Commands] Failed to scan directory ${dir}:`, err);
  }

  return commands;
}

/** Each vetted plugin's CANONICAL `commands/` (never a projection), prefixed with the plugin name. */
async function scanPluginCommands(): Promise<FileCommand[]> {
  const pins = await vettedStagedPlugins();
  const perPlugin = await Promise.all(
    pins.map((plugin) => scanPluginPayloadCommands(plugin, plugin.name)),
  );
  // A plugin unstaged while its payload was being scanned must not surface stale commands.
  const stillStaged = new Set((await vettedStagedPlugins()).map((plugin) => plugin.name));
  return pins.flatMap((plugin, i) => (stillStaged.has(plugin.name) ? perPlugin[i] : []));
}

/**
 * List all commands from the filesystem, deduped by name.
 * Priority (first seen wins): frink > cursor > claude, project > user; vendor plugins last.
 */
export async function listCommands(projectPath?: string): Promise<FileCommand[]> {
  const home = frinkUserHome();

  const promises: Promise<FileCommand[]>[] = [
    scanCommandsDirectory(path.join(home, '.frink', 'commands'), 'user', 'frink'),
    scanCommandsDirectory(path.join(home, '.cursor', 'commands'), 'user', 'cursor'),
    scanCommandsDirectory(path.join(home, '.claude', 'commands'), 'user', 'claude'),
    scanPluginCommands(),
  ];

  if (projectPath) {
    promises.push(
      scanCommandsDirectory(path.join(projectPath, '.frink', 'commands'), 'project', 'frink'),
      scanCommandsDirectory(path.join(projectPath, '.cursor', 'commands'), 'project', 'cursor'),
      scanCommandsDirectory(path.join(projectPath, '.claude', 'commands'), 'project', 'claude'),
    );
  }

  const results = await Promise.all(promises);

  let ordered: FileCommand[];
  if (projectPath) {
    const [frinkUser, cursorUser, claudeUser, plugin, frinkProject, cursorProject, claudeProject] =
      results;
    ordered = [
      ...frinkProject,
      ...cursorProject,
      ...claudeProject,
      ...frinkUser,
      ...cursorUser,
      ...claudeUser,
      ...plugin,
    ];
  } else {
    const [frinkUser, cursorUser, claudeUser, plugin] = results;
    ordered = [...frinkUser, ...cursorUser, ...claudeUser, ...plugin];
  }

  const seenNames = new Set<string>();
  return ordered.filter((cmd) => {
    if (seenNames.has(cmd.name)) return false;
    seenNames.add(cmd.name);
    return true;
  });
}

/** Reject paths that escape the readable command directories. */
async function assertCommandPath(filePath: string): Promise<void> {
  if (filePath.includes('..') || !(await isReadableCommandPath(filePath))) {
    throw new Error('Invalid path');
  }
}

/** Read a command file body with frontmatter stripped. Returns '' on read error. */
export async function getCommandContent(filePath: string): Promise<string> {
  await assertCommandPath(filePath);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const { content } = matter(raw);
    return content.trim();
  } catch (_err) {
    return '';
  }
}

/** Read a command file with frontmatter parsed (for the command editor). */
export async function getCommandFull(filePath: string): Promise<{
  description: string;
  argumentHint: string;
  content: string;
}> {
  await assertCommandPath(filePath);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const { data, content } = matter(raw);
    return {
      description: typeof data.description === 'string' ? data.description : '',
      argumentHint: typeof data['argument-hint'] === 'string' ? data['argument-hint'] : '',
      content: content.trim(),
    };
  } catch (_err) {
    return { description: '', argumentHint: '', content: '' };
  }
}
