import { existsSync, realpathSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import log from 'electron-log';
import { BUILD_PROJECT_PLACEHOLDER, buildsRootDir, isManagedBuildPath } from './builds-path';
import { getDatabase } from './db';
import {
  createProject as createProjectLocal,
  deleteProject as deleteProjectLocal,
  getProjectByPath as getProjectByPathLocal,
} from './db/repos/projects';
import { goalToSlug } from './goal-slug';
import { frinkUserHome } from './platform/frink-home';

/**
 * Goal-first scaffold (epic sc-788) — a quick start for anyone, dev or not.
 *
 * Turns a free-form goal ("a dashboard", "a script to rename my files") into a ready-to-use
 * plain project: a folder under `~/.frink/builds/<slug>`, no git, registered for file access.
 * The agent then writes into it via a chat created with `useWorktree:false`. Any project shape
 * is fine (a page, a React app, a script); nothing is pre-seeded but the guidance. Git stays optional.
 */

/** Guidance auto-injected (via readAgentsMd) into quick-start builds — inclusive + project-agnostic. */
const QUICKSTART_AGENTS_MD = `# How to help here

This is a quick scratch project. Someone wants to build or try something fast, without the usual setup. They might be a first-timer or a developer spinning up a demo or experiment. Read the goal and meet them where they are.

- Build whatever fits the goal: a single HTML page, a small React app, a Python script, a CLI tool. Don't force one shape; prefer the simplest thing that runs with the fewest steps.
- Keep it self-contained and easy to run. Avoid heavy setup unless the goal needs it; if you add dependencies or a build step, say so in one plain sentence.
- Work in small steps. After each change, say in one sentence what they can now see, run, or do.
- Match their language: plain English for a beginner (skip git, terminals, and jargon unless they ask); normal shorthand for someone who clearly knows their way around.
- Default to doing, not explaining. Show the result.
`;

/**
 * AGENTS.md is the cross-tool standard (Cursor reads it; Frink injects it via readAgentsMd), but
 * Claude Code loads CLAUDE.md, not AGENTS.md. Seed a CLAUDE.md that `@`-imports AGENTS.md so the
 * SAME guidance applies natively for Claude Code too — one source (AGENTS.md), no duplication.
 */
const BUILD_CLAUDE_MD = `Project guidance for this build lives in AGENTS.md:

@AGENTS.md
`;

const UNIQUE_PATH_ERROR_REGEX = /UNIQUE constraint failed: projects\.path/i;

/**
 * Create a gitless plain-folder project from a goal. Registers the path (mandatory — without
 * it the agent's first file write is denied) and seeds AGENTS.md + a CLAUDE.md that imports it
 * (so both Cursor and Claude Code respect the guidance), no forced entry file.
 *
 * Tries slug, slug-2, slug-3… The pre-check (disk + DB) skips obvious collisions, and the
 * createProject UNIQUE(path) violation is caught so two concurrent same-goal builds — e.g.
 * "Build it" hit in two panes at once — settle on distinct folders instead of crashing.
 */
export async function scaffoldBuild(goal: string) {
  const db = getDatabase();
  const baseDir = buildsRootDir(frinkUserHome());
  await mkdir(baseDir, { recursive: true });
  const slug = goalToSlug(goal);

  for (let i = 1; ; i++) {
    // The FOLDER is the slug (deduped) — invisible plumbing. The DISPLAY name starts as a
    // placeholder and is replaced by the chat auto-namer's friendly title (maybeNameBuildProject).
    const folderName = i === 1 ? slug : `${slug}-${i}`;
    const path = join(baseDir, folderName);
    if (existsSync(path) || (await getProjectByPathLocal(db, path))) continue;

    let project: Awaited<ReturnType<typeof createProjectLocal>>;
    try {
      // Insert the row first: the UNIQUE(path) constraint is the serialization point that
      // lets concurrent same-goal scaffolds settle on distinct folders.
      project = await createProjectLocal(db, { name: BUILD_PROJECT_PLACEHOLDER, path });
    } catch (err) {
      // Lost a race to a concurrent scaffold — try the next suffix.
      if (err instanceof Error && UNIQUE_PATH_ERROR_REGEX.test(err.message)) continue;
      throw err;
    }

    try {
      await mkdir(path, { recursive: true });
      await writeFile(join(path, 'AGENTS.md'), QUICKSTART_AGENTS_MD, 'utf8');
      await writeFile(join(path, 'CLAUDE.md'), BUILD_CLAUDE_MD, 'utf8');
    } catch (err) {
      // Folder/seed write failed — roll back the row so we don't leave a project
      // pointing at a non-existent directory.
      await deleteProjectLocal(db, project.id).catch(() => {});
      log.error('[scaffoldBuild] Failed to seed build folder:', path, err);
      throw err;
    }

    return project;
  }
}

/**
 * Remove a Frink-managed build folder from disk. Resolves symlinks first so a symlinked ~/.frink
 * can't escape the gate (fail safe: skip if it resolves outside builds), and never throws — a
 * locked/failed removal is logged, not propagated, so deleting the project always succeeds.
 */
export async function removeManagedBuildFolder(
  projectPath: string,
  homeDir: string,
): Promise<void> {
  try {
    const resolved = realpathSync(projectPath);
    if (isManagedBuildPath(resolved, realpathSync(homeDir))) {
      await rm(resolved, { recursive: true, force: true });
    }
  } catch (err) {
    log.warn('[project-scaffold] build folder cleanup skipped:', projectPath, err);
  }
}
