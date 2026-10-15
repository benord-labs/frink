import picomatch from 'picomatch';

/** Reads in the chat's folder that still ask, as OpenCode wildcards: * spans folders, last wins. */
export const ENV_FILE_READS = {
  '*': 'allow',
  '*.env': 'ask',
  '*.env.*': 'ask',
  '*.env.example': 'allow',
} as const;

// bash: true lets * span folders as OpenCode's does, so *.env matches config/.env; case is
// ignored because macOS disks open .ENV as .env.
const ENV_FILE_MATCH = { dot: true, bash: true, nocase: true };

/** True when opening this path, relative to the chat's folder, asks first. */
export function envFileAsks(relativePath: string): boolean {
  const rules = Object.entries(ENV_FILE_READS);
  const last = rules.findLast(([rule]) => picomatch.isMatch(relativePath, rule, ENV_FILE_MATCH));
  return last?.[1] === 'ask';
}

// Past these sizes the check stops and counts the glob as reaching an env file.
const MAX_SPELLINGS = 64;
const MAX_GLOB = 512;
const BRACE_GROUP = /\{([^{}]*)\}/;
// One glob token: a run of stars, a bracket class (POSIX classes too), or one character.
const GLOB_TOKEN = /\*+|\[[!^]?\]?(?:\[:[a-z]+:\]|[^\]])*\]|./gsu;
const ONE_CHAR = { dot: true, nocase: true };

/** Every brace-free glob a glob spells, or undefined when there are too many to check. */
function spellings(glob: string): string[] | undefined {
  let globs = [glob];
  while (globs.some((each) => BRACE_GROUP.test(each))) {
    globs = globs.flatMap((each) => {
      const group = BRACE_GROUP.exec(each);
      if (!group) return [each];
      const [head, tail] = [each.slice(0, group.index), each.slice(group.index + group[0].length)];
      return group[1].split(',').map((option) => head + option + tail);
    });
    if (globs.length > MAX_SPELLINGS) return undefined;
  }
  return globs;
}

/** The token positions a match can be at, with each star also passed over. */
function passStars(tokens: string[], states: Iterable<number>): Set<number> {
  const all = new Set(states);
  for (const at of all) {
    if (tokens[at]?.startsWith('*')) all.add(at + 1);
  }
  return all;
}

/** True when a glob token that stands for one character can be char, in any letter case. */
function readsChar(token: string, char: string): boolean {
  if (token === '?') return true;
  if (token.length === 1) return token.toLowerCase() === char;
  // picomatch misreads a [!x] class, so it gets [^x], which every glob reader means by it.
  return picomatch.isMatch(char, token.replace(/^\[!/, '[^'), ONE_CHAR);
}

/** Where a match can be once the tokens have read text; a star reads it only when stars is set. */
function read(tokens: string[], from: Iterable<number>, text: string, stars = true): Set<number> {
  let states = passStars(tokens, from);
  for (const char of text) {
    const next = [...states].flatMap((at) => {
      const token = tokens[at];
      if (token?.startsWith('*')) return stars ? [at] : [];
      return token !== undefined && readsChar(token, char) ? [at + 1] : [];
    });
    states = passStars(tokens, next);
  }
  return states;
}

/** True when the tokens can hold .env. with a glob character, not a *, giving part of its .env. */
function spellsEnvDot(tokens: string[]): boolean {
  // A * covering all of .env is not counted, or every *.ts search would ask (*.ts has .env.ts).
  return [...'.env'].some((char, at) => {
    const before = read(tokens, tokens.keys(), '.env'.slice(0, at));
    return read(tokens, read(tokens, before, char, false), `${'.env'.slice(at + 1)}.`).size > 0;
  });
}

/** True when a brace-free glob can match a path envFileAsks asks about. */
function spellingAsks(glob: string): boolean {
  if (!/[*?[]/.test(glob)) return envFileAsks(glob);
  // Every path it matches ends in .env.example, the template the rule lets through.
  if (/\.env\.example$/i.test(glob)) return false;
  const tokens = glob.match(GLOB_TOKEN) ?? [];
  return read([...tokens].reverse(), [0], 'vne.').size > 0 || spellsEnvDot(tokens);
}

/** True when a search filtered by this glob, relative to its root, can open an env file. */
export function envGlobAsks(glob: string): boolean {
  // Extended groups and classes inside braces are not modelled, so they count as reaching one.
  if (/[()]|\{[^}]*\[/.test(glob) || glob.length > MAX_GLOB) return true;
  const options = spellings(glob);
  return !options || options.some(spellingAsks);
}
