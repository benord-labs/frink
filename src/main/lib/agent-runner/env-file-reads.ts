import picomatch from 'picomatch';

/** Reads in the chat's folder that still ask, as OpenCode wildcards: * spans folders, last wins. */
export const ENV_FILE_READS = {
  '*': 'allow',
  '*.env': 'ask',
  '*.env.*': 'ask',
  '*.env.example': 'allow',
} as const;

// OpenCode's * spans folders; case is ignored because macOS disks open .ENV as .env.
const ENV_FILE_MATCH = { dot: true, bash: true, nocase: true };

/** True when opening this path, relative to the chat's folder, asks first. */
export function envFileAsks(relativePath: string): boolean {
  const rules = Object.entries(ENV_FILE_READS);
  const last = rules.findLast(([rule]) => picomatch.isMatch(relativePath, rule, ENV_FILE_MATCH));
  return last?.[1] === 'ask';
}
