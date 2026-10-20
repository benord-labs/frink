import path from 'path';
import { buildOpenWorktreeFileInput } from '@/lib/worktree/open-worktree-file-in-editor';

// Adapted from T3 Code's markdownLinks.ts and fileLinks.ts (MIT).

/** A local file named in chat markdown, and the line it points at when it gives one. */
export type FileLinkTarget = { path: string; line?: number };

const PATH_PREFIX = /^(?:~|\.{0,2})\//;
// `:12`, `:12:5` or `:195-233`; a range keeps its start line.
const LINE_SUFFIX = /:(\d+)(?:[:-]\d+)?$/;
// A trailing `#L12`, `#L12C3` or `#L12-L20`; any other `#` belongs to the file's name.
const HASH_LINE = /#L(\d+)(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/i;
const FILE_EXTENSION = /\.[\w-]+$/;
// A final dot between digits marks a version or model id (`glm-5.3`), not an extension.
const VERSION_SUFFIX = /\d\.\d[^.]*$/;
const URL_SCHEME = /^[a-z][\w+.-]*:(?!\d)/i;
// Globs and placeholders such as `lib/*.ts`, `<slug>` or `$HOME` name no single file.
const PLACEHOLDER = /[*?<>{}$]|\.\.\./;
// A trailing slash, `.` or `..` names a folder.
const FOLDER = /(?:^|\/)\.{0,2}$/;
// A dot-name with no extension is a folder (`~/.ssh`) as often as a file.
const HIDDEN_NAME = /(?:^|\/)\.[^./]+$/;
const FILESYSTEM_ROOT =
  /^\/(?:Users|home|tmp|var|etc|opt|mnt|Volumes|private|root|usr|s?bin|lib(?:64)?|srv|dev|proc|sys|run|boot|media|workspaces?)\//;
const LOCAL_HOST = /^(?:localhost|\d+(?:\.\d+)+)$/i;
const GENERIC_HOST =
  /^[^.].*\.(?:com|net|org|io|dev|app|ai|co|edu|gov|mil|info|biz|xyz|me|tv|gg|chat|cloud|site|online|tech|store|link)$/i;
// Country domains are also file extensions (`.pl`, `.cc`), so a line number outranks them.
const COUNTRY_HOST =
  /^[^.].*\.(?:uk|de|fr|nl|se|no|fi|dk|pl|ch|at|be|es|it|pt|eu|us|ca|au|nz|jp|kr|cn|br|ru|mx|ie|cz|tr|sg|hk|cc)$/i;
const EDGE_SLASHES = /^\.\/|\/+$/g;
// A name with an extension and no folder, line, scheme or leading dot: `index.ts`, `package.json`.
const BARE_NAME = /^[^\s/\\:.][^\s/\\:]*\.[\w-]+$/;

function splitLine(raw: string): FileLinkTarget {
  const suffix = LINE_SUFFIX.exec(raw);
  if (!suffix) return { path: raw };
  return { path: raw.slice(0, suffix.index), line: Number(suffix[1]) || undefined };
}

function looksLikeHostname(segment: string, hasLine: boolean): boolean {
  return (
    LOCAL_HOST.test(segment) ||
    GENERIC_HOST.test(segment) ||
    (!hasLine && COUNTRY_HOST.test(segment))
  );
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function fileUrlPath(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname && parsed.hostname !== 'localhost'
      ? null
      : parsed.pathname + parsed.hash;
  } catch {
    return null;
  }
}

// Only a `:line` marks a dot-name (`~/.ssh`) or a route-shaped path (`/api/users`) as a file.
// A `#L3` anchor does not: a web route links to a heading the same way.
function needsLine(file: string): boolean {
  if (HIDDEN_NAME.test(file)) return true;
  return (
    file.startsWith('/') && !FILESYSTEM_ROOT.test(file) && !FILE_EXTENSION.test(path.basename(file))
  );
}

function fileTarget(raw: string, hashLine?: number): FileLinkTarget | null {
  if (PLACEHOLDER.test(raw) || raw.startsWith('//')) return null;
  const { path: file, line } = splitLine(raw);
  if (FOLDER.test(file) || (line === undefined && needsLine(file))) return null;
  return { path: file, line: line ?? hashLine };
}

/** Reads a link destination naming a local file: absolute, `./`, `../`, `~/` or a `file:` URL. */
export function parseFileLinkTarget(url: string): FileLinkTarget | null {
  const destination = url.trim().replace(/^<(.*)>$/, '$1');
  const local = /^file:/i.test(destination) ? fileUrlPath(destination) : destination;
  if (!local || !PATH_PREFIX.test(local)) return null;
  const anchor = HASH_LINE.exec(local);
  const file = anchor ? local.slice(0, anchor.index) : local;
  return fileTarget(decodePath(file), Number(anchor?.[1]) || undefined);
}

/** Reads path-shaped inline code such as `src/a.ts:42`; bare names, hosts, URLs and globs stay code. */
export function inlineCodeFileTarget(code: string): FileLinkTarget | null {
  const text = code.trim();
  if (!text || /\s/.test(text) || URL_SCHEME.test(text)) return null;
  const target = fileTarget(text);
  if (!target || (target.line === undefined && !text.includes('/'))) return null;
  if (PATH_PREFIX.test(text)) return target;
  const name = path.basename(target.path);
  const [first = ''] = target.path.split('/');
  // A colon in the first segment is a host with a port (`localhost:5173/src`).
  const isHost = first.includes(':') || looksLikeHostname(first, target.line !== undefined);
  return !isHost && FILE_EXTENSION.test(name) && !VERSION_SUFFIX.test(name) ? target : null;
}

/** Reads a bare file name in inline code, such as `index.ts`: a file only once the project has exactly one.
 * Host-shaped names (`main.pl`, `example.com`) are looked up too: only a real project file matches. */
export function bareFileNameTarget(code: string): FileLinkTarget | null {
  const name = code.trim();
  const isName = BARE_NAME.test(name) && !PLACEHOLDER.test(name) && !VERSION_SUFFIX.test(name);
  return isName ? { path: name } : null;
}

/** True for a reference written as a name alone, which only a project lookup can place. */
export function isBareFileName(file: string): boolean {
  return !file.includes('/');
}

/** True when a reference's own text is just the file's name or path, so the badge alone says it. */
export function isFileNameLabel(label: string, target: FileLinkTarget): boolean {
  const own = splitLine(label.trim());
  if (own.line !== undefined && own.line !== target.line) return false;
  const name = own.path.replace(EDGE_SLASHES, '');
  const file = target.path.replace(EDGE_SLASHES, '');
  return name === '' || file === name || file.endsWith(`/${name}`);
}

/** Where a chat's file references point: its home folder and the folder it works in. */
type FileLinkBase = {
  home: string | undefined;
  root: string | null | undefined;
  isWorktreeContext: boolean;
  chatId: string | null;
};

/** What opens a referenced file in the editor; null when it lies outside the chat's working folder. */
export function fileLinkOpenInput(
  file: string,
  { home, root, isWorktreeContext, chatId }: FileLinkBase,
) {
  // A `~/` path starts at the home folder, so it waits for one; any other loses its `./` parts.
  const filePath = file.startsWith('~/')
    ? home && path.join(home, file.slice(2))
    : path.normalize(file);
  if (!chatId || !filePath) return null;
  return buildOpenWorktreeFileInput({ filePath, worktreePath: root, isWorktreeContext, chatId });
}

export type FileLinkOpenInput = NonNullable<ReturnType<typeof fileLinkOpenInput>>;

/** True for a path written with no `/`, `~/`, `./` or `../` in front: the only kind that may be shortened. */
export function isBareRelativePath(file: string): boolean {
  return !PATH_PREFIX.test(file);
}

/** The full path a shortened one stands for: the only project entry, file or folder, that ends with it. */
export function findShortenedPath(file: string, entries: { path: string }[]): string | undefined {
  // Windows lists project entries with `\`.
  const tails = entries.filter((entry) => entry.path.replaceAll('\\', '/').endsWith(`/${file}`));
  return tails.length === 1 ? tails[0].path : undefined;
}
