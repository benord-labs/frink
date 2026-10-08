import fs from 'node:fs';
import path from 'node:path';
import log from 'electron-log';
import { frinkUserHome } from '../../platform/frink-home';
import { captureMainException } from '../../sentry/init';

const INDEX_FILE = 'MEMORY.md';
/** Written in the sessions root once every per-chat memory has been merged. */
const MERGED_MARKER = '.auto-memory-merged';

type ChatMemory = {
  file: string;
  source: string;
  slug: string;
  mtimeMs: number;
  indexLine: string;
};

let mergeRun: Promise<void> | null = null;

async function readText(file: string): Promise<string> {
  try {
    return await fs.promises.readFile(file, 'utf-8');
  } catch {
    return '';
  }
}

async function readEntries(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** The source index's line for `file`, else a bare link, so a merged memory stays indexed. */
function indexLineFor(index: string, file: string): string {
  const line = index.split('\n').find((candidate) => candidate.includes(`](${file})`));
  return line?.trimEnd() ?? `- [${file}](${file})`;
}

/** One project's memories in one chat dir; a symlinked memory dir or file is never followed. */
async function readMemoryDir(memoryDir: string, slug: string): Promise<ChatMemory[]> {
  const stat = await fs.promises.lstat(memoryDir).catch(() => null);
  if (!stat?.isDirectory()) return [];
  const files = (await readEntries(memoryDir)).filter(
    (entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== INDEX_FILE,
  );
  if (files.length === 0) return [];
  const index = await readText(path.join(memoryDir, INDEX_FILE));
  return Promise.all(
    files.map(async ({ name }) => {
      const source = path.join(memoryDir, name);
      const { mtimeMs } = await fs.promises.lstat(source);
      return { file: name, source, slug, mtimeMs, indexLine: indexLineFor(index, name) };
    }),
  );
}

/** Every per-chat memory under `<sessionsRoot>/<chat>/projects/<slug>/memory`, newest first. */
async function collectChatMemories(sessionsRoot: string): Promise<ChatMemory[]> {
  const memories: ChatMemory[] = [];
  for (const chat of await readEntries(sessionsRoot)) {
    if (!chat.isDirectory()) continue;
    const projectsDir = path.join(sessionsRoot, chat.name, 'projects');
    for (const project of await readEntries(projectsDir)) {
      if (!project.isDirectory()) continue;
      const memoryDir = path.join(projectsDir, project.name, 'memory');
      memories.push(...(await readMemoryDir(memoryDir, project.name)));
    }
  }
  return memories.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Copy one memory into its project folder unless a file of that name is there; index it if copied. */
async function copyIntoProject(memory: ChatMemory, claudeHome: string): Promise<boolean> {
  const targetDir = path.join(claudeHome, 'projects', memory.slug, 'memory');
  await fs.promises.mkdir(targetDir, { recursive: true });
  try {
    const target = path.join(targetDir, memory.file);
    await fs.promises.copyFile(memory.source, target, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    // SAFETY: fs.promises rejects with a NodeJS.ErrnoException.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  const indexPath = path.join(targetDir, INDEX_FILE);
  const index = await readText(indexPath);
  if (index.includes(`](${memory.file})`)) return true;
  const separator = index === '' || index.endsWith('\n') ? '' : '\n';
  await fs.promises.appendFile(indexPath, `${separator}${memory.indexLine}\n`);
  return true;
}

/** Copy every per-chat memory into the project folder Claude Code shares; the marker ends it for good. */
async function mergeChatMemories(sessionsRoot: string): Promise<void> {
  const marker = path.join(sessionsRoot, MERGED_MARKER);
  if (fs.existsSync(marker)) return;
  const claudeHome = path.join(frinkUserHome(), '.claude');
  let copied = 0;
  let kept = 0;
  let failed = 0;
  for (const memory of await collectChatMemories(sessionsRoot)) {
    try {
      if (await copyIntoProject(memory, claudeHome)) copied++;
      else kept++;
    } catch (error) {
      failed++;
      log.warn(`[auto-memory] could not merge ${memory.source}:`, error);
    }
  }
  log.info(`[auto-memory] per-chat merge: copied=${copied} kept-existing=${kept} failed=${failed}`);
  // A failed file leaves the marker unwritten: the next launch retries, and copies never overwrite.
  if (failed === 0) await fs.promises.writeFile(marker, '');
}

/** Merge memories from when Frink kept auto-memory per chat into the projects' shared folders, once
 * per process before any CLI spawns. Never rejects: a chat must start even if this fails. */
export function mergeChatMemoriesOnce(sessionsRoot: string): Promise<void> {
  mergeRun ??= mergeChatMemories(sessionsRoot).catch((error) => {
    log.warn('[auto-memory] per-chat merge failed:', error);
    captureMainException(error, { surface: 'claude-auto-memory-merge' });
  });
  return mergeRun;
}

/** Test-only: forget this process's merge run. */
export function _resetChatMemoryMergeForTests(): void {
  mergeRun = null;
}
