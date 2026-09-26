import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import log from 'electron-log';
import matter from 'gray-matter';
import { commandNameToRelPath, getCommandContent, listCommands } from '../../commands';
import { ensureDirExistsAsync } from '../../fs-helpers';
import type { ProviderType } from '../types';
import type { CategoryHandler } from './types';
import { frinkUserHome } from '../../platform/frink-home';

/**
 * PCH-2b — deliver Frink-owned slash-commands to a provider's MACHINE-LOCAL,
 * user-global command dir (NOT the committed project `.claude`/`.cursor`). Idempotent.
 *
 * Provenance: each projected file carries `frinkProjected: true` in frontmatter so
 * it is never mistaken for a user-authored command and a later reconcile can prune
 * stale projections. There is no command importer, so projecting cannot create a
 * write→read→re-write loop (listCommands dedups frink > cursor > claude by name).
 */

/** Provider → machine-local user-global commands dir. Lazy so tests can mock homedir(). */
function providerCommandDir(provider: ProviderType): string | null {
  const home = frinkUserHome();
  if (provider === 'claude-code') return path.join(home, '.claude', 'commands');
  if (provider === 'cursor') return path.join(home, '.cursor', 'commands');
  // codex/gemini/opencode: descriptor `commands` is `none`; codex reads no commands dir (sc-2800).
  return null;
}

export const deliverCommands: CategoryHandler = async ({ mode, ctx }) => {
  const targetDir = providerCommandDir(ctx.provider);
  if (!targetDir) {
    return {
      category: 'commands',
      mode,
      status: 'noop',
      detail: `no command dir for ${ctx.provider}`,
    };
  }

  const frinkCommands = (await listCommands()).filter((cmd) => cmd.origin === 'frink');
  let written = 0;
  for (const cmd of frinkCommands) {
    try {
      const content = await getCommandContent(cmd.path);
      const md = matter.stringify(content, {
        ...(cmd.description ? { description: cmd.description } : {}),
        frinkProjected: true,
      });
      const dest = path.join(targetDir, `${commandNameToRelPath(cmd.name)}.md`);
      // Never clobber a user-authored command of the same name — only overwrite
      // our own prior projection (provenance-marked) or write a fresh file.
      try {
        const existing = await fs.readFile(dest, 'utf-8');
        if (matter(existing).data.frinkProjected !== true) {
          log.warn(
            `[provider] deliver:commands skip ${cmd.name}: non-frink command already at target`,
          );
          continue;
        }
      } catch {
        // dest does not exist — safe to write.
      }
      await ensureDirExistsAsync(path.dirname(dest));
      await fs.writeFile(dest, `${md.trimEnd()}\n`, 'utf-8');
      written += 1;
    } catch (err) {
      log.warn(`[provider] deliver:commands skip ${cmd.name}: ${String(err)}`);
    }
  }

  log.info(
    `[provider] deliver:commands → ${ctx.provider}: ${written}/${frinkCommands.length} projected`,
  );
  return {
    category: 'commands',
    mode,
    status: 'delivered',
    detail: `projected ${written} frink command(s) → ${ctx.provider}`,
  };
};
