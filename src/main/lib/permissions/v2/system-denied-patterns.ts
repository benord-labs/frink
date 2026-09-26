/**
 * System-denied path patterns + matcher.
 *
 * Ported verbatim from `src/main/lib/permissions/store.ts:47-505` (ticket 04 of
 * the permissions overhaul). Single source of truth so ticket 14 can delete
 * `store.ts` without losing this list.
 *
 * Pure-ish: only I/O is `fs.lstatSync`/`fs.readlinkSync`/`fs.realpathSync.native`
 * for the `.env.example` symlink chase. No electron / sqlite / tRPC imports.
 *
 * The pattern LIST is preserved verbatim from the legacy helper (ticket 04 §39
 * forbids list edits without a separate security review). The MATCHER LOGIC
 * is REPLACED — the legacy basename-only matcher silently failed for
 * directory-glob patterns (`**\/.ssh\/**`, `**\/.config/gcloud\/**`) and
 * slash-bearing exact patterns (`**\/.git/config`), allowing project-local
 * `.aws/credentials`, `.ssh/known_hosts`, etc. to slip through. Fixed here
 * because the ticket forbids changing the *list* (patterns), not fixing the
 * *matcher* that operates on it. The .env.example symlink-chase logic is
 * still ported verbatim.
 */

import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';

/**
 * System-denied path patterns (glob format).
 * NEVER allowed regardless of user permissions. Frontend may fetch via tRPC for display.
 */
export const SYSTEM_DENIED_PATTERNS = [
  '**/.ssh/**',
  '**/.aws/**',
  '**/.gnupg/**',
  '**/.gitconfig',
  '**/.git/config',
  '**/.env',
  '**/.env.*',
  '**/credentials.json',
  '**/secrets.*',
  '**/*.pem',
  '**/*.key',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/.config/gcloud/**',
] as const satisfies readonly string[];

/**
 * Home-directory exact paths denied even outside the project root.
 * Uses `os.homedir()` (equivalent to electron's `app.getPath('home')` on macOS,
 * Linux, and Windows). Built at module init.
 */
export const SYSTEM_DENIED_EXACT = [
  nodePath.join(nodeOs.homedir(), '.ssh'),
  nodePath.join(nodeOs.homedir(), '.aws'),
  nodePath.join(nodeOs.homedir(), '.gnupg'),
  nodePath.join(nodeOs.homedir(), '.gitconfig'),
  nodePath.join(nodeOs.homedir(), '.config/gcloud'),
] as const;

/**
 * True when `path` matches the hard-coded deny list.
 * - Resolves relative paths against `projectRoot` when supplied; otherwise
 *   `nodePath.resolve(path)` matches the legacy single-arg semantics.
 * - Symlink-aware for `.env.example`: walks the symlink chain so a
 *   `.env.example` → `.env` redirect is denied (would otherwise bypass).
 * - Dangling `.env.example` symlinks → deny (write would create the target).
 */
export function isSystemDeniedPath(path: string, projectRoot?: string): boolean {
  const targetPath = nodePath.isAbsolute(path)
    ? path
    : projectRoot
      ? nodePath.resolve(projectRoot, path)
      : nodePath.resolve(path);

  const basename = nodePath.basename(targetPath);
  const isWin32 = process.platform === 'win32';
  const basenameNorm = isWin32 ? basename.toLowerCase() : basename;

  // .env.example is a public template (no secrets) — always allow read/write.
  // Resolve full symlink chain so .env.example -> x/.env.example -> .env cannot bypass.
  // Dangling symlinks: if .env.example is a symlink to missing .env, deny (write would create .env).
  if (basenameNorm === '.env.example') {
    try {
      const stat = nodeFs.lstatSync(targetPath);
      if (stat.isSymbolicLink()) {
        const visited = new Set<string>();
        let current = targetPath;
        while (true) {
          const canonical = nodePath.resolve(current);
          if (visited.has(canonical)) break;
          visited.add(canonical);
          const linkTarget = nodeFs.readlinkSync(current);
          const next = nodePath.resolve(nodePath.dirname(current), linkTarget);
          try {
            const nextStat = nodeFs.lstatSync(next);
            if (!nextStat.isSymbolicLink()) {
              const finalBasename = nodePath.basename(next);
              const finalNorm = isWin32 ? finalBasename.toLowerCase() : finalBasename;
              if (finalNorm !== '.env.example') return true;
              return false;
            }
            current = next;
          } catch {
            // Dangling or missing target — deny (e.g. .env.example -> .env where .env doesn't exist yet)
            return true;
          }
        }
        return true; // Symlink loop — deny
      }
      if (!nodeFs.existsSync(targetPath)) return false; // Creating new file — allow
      const realPath = nodeFs.realpathSync.native(targetPath);
      const realBasename = nodePath.basename(realPath);
      const realBasenameNorm = isWin32 ? realBasename.toLowerCase() : realBasename;
      if (realBasenameNorm === '.env.example') return false; // Genuine file — allow
      // Symlink to something else (e.g. .env) — fall through to deny
    } catch {
      return false; // Path missing (create) — allow
    }
  }

  // Check exact matches
  const targetNorm = isWin32 ? nodePath.normalize(targetPath).toLowerCase() : targetPath;
  for (const denied of SYSTEM_DENIED_EXACT) {
    const deniedNorm = isWin32 ? denied.toLowerCase() : denied;
    if (targetNorm === deniedNorm || targetNorm.startsWith(`${deniedNorm}${nodePath.sep}`)) {
      return true;
    }
  }

  // Check patterns. Each `SYSTEM_DENIED_PATTERNS` entry starts with `**/`.
  // After stripping that prefix, the suffix falls into one of four shapes:
  //   1. ends with `/**`        → directory glob (any file under that dir at any depth)
  //   2. contains `/` otherwise → exact path-tail (path ends with `/<suffix>`)
  //   3. contains `*`           → basename glob (prefix*suffix on basename)
  //   4. plain                  → basename equality
  const pathParts = targetPath.split(nodePath.sep);
  const pathPartsNorm = isWin32 ? pathParts.map((p) => p.toLowerCase()) : pathParts;

  for (const pattern of SYSTEM_DENIED_PATTERNS) {
    if (!pattern.startsWith('**/')) continue;
    const suffix = pattern.slice(3);
    const suffixNorm = isWin32 ? suffix.toLowerCase() : suffix;

    // (1) Directory glob: `**/.ssh/**`, `**/.config/gcloud/**`
    if (suffixNorm.endsWith('/**')) {
      const dirPath = suffixNorm.slice(0, -3); // ".ssh" or ".config/gcloud"
      const dirParts = dirPath.split('/');
      // Look for the contiguous run of `dirParts` anywhere in `pathPartsNorm`
      // such that there's at least one more segment after — i.e. the file is
      // INSIDE the dir, not the dir itself.
      const limit = pathPartsNorm.length - dirParts.length;
      for (let i = 0; i < limit; i++) {
        let match = true;
        for (let j = 0; j < dirParts.length; j++) {
          if (pathPartsNorm[i + j] !== dirParts[j]) {
            match = false;
            break;
          }
        }
        if (match) return true;
      }
      continue;
    }

    // (2) Exact path-tail with `/`: `**/.git/config`
    if (suffixNorm.includes('/')) {
      const targetForCompare = isWin32 ? targetPath.toLowerCase() : targetPath;
      const sep = nodePath.sep;
      const needle = sep + suffixNorm.split('/').join(sep);
      if (targetForCompare.endsWith(needle)) return true;
      continue;
    }

    // (3) Basename glob: `**/*.pem`, `**/id_rsa*`, `**/.env.*`, `**/secrets.*`
    if (suffixNorm.includes('*')) {
      const parts = suffixNorm.split('*');
      const prefix = parts[0];
      const suffixPart = parts[1] ?? '';
      const prefixMatch = prefix === '' || basenameNorm.startsWith(prefix);
      const suffixMatch = suffixPart === '' || basenameNorm.endsWith(suffixPart);
      if (prefixMatch && suffixMatch && (prefix !== '' || suffixPart !== '')) {
        return true;
      }
      continue;
    }

    // (4) Plain basename equality: `**/.gitconfig`, `**/.env`, `**/credentials.json`
    if (basenameNorm === suffixNorm) return true;
  }

  return false;
}

/**
 * True when `absolutePath` is a file that lives inside `allowedRoot`.
 *
 * Used to bypass the permission prompt for tool invocations against app-owned
 * per-chat directories (paste-blob storage, session plans, session tool-result
 * spill files) — content the user or the app itself already owns.
 *
 * Hardening (ticket 15 — defense-in-depth):
 *   1. `path.resolve` normalizes `../` traversal before comparison.
 *   2. The parent directory's realpath must stay inside `allowedRoot`'s
 *      realpath. Catches symlinks pointing outside the allowed root.
 *   3. Caller is responsible for chat-isolation: pass only the active chat's
 *      dirs so chat A's agent cannot read chat B's files.
 *   4. **Run AFTER `isSystemDeniedPath`**. The deny list is the kill-switch;
 *      auto-allow must never bypass it.
 */
export function isAutoAllowedPath(absolutePath: string, allowedRoot: string): boolean {
  if (!absolutePath || !allowedRoot) return false;

  // 1. Normalize the input path (resolves `../`, redundant separators).
  const resolved = nodePath.resolve(absolutePath);
  const root = nodePath.resolve(allowedRoot);

  // 2. Lexical containment: input must be inside (or equal to) the root.
  if (resolved !== root && !resolved.startsWith(root + nodePath.sep)) return false;

  // 3. Realpath the PARENT directory (target file itself may not exist yet
  //    — agent's Read happens after the paste-write, so existence is expected,
  //    but be safe).
  let realParent: string;
  try {
    realParent = nodeFs.realpathSync.native(nodePath.dirname(resolved));
  } catch {
    return false;
  }

  // 4. Realpath the root for symlink-safe comparison.
  let realRoot: string;
  try {
    realRoot = nodeFs.existsSync(root) ? nodeFs.realpathSync.native(root) : root;
  } catch {
    realRoot = root;
  }

  // 5. The real parent must stay inside the real root after symlink resolution.
  return realParent === realRoot || realParent.startsWith(realRoot + nodePath.sep);
}
