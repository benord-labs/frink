import fs from 'node:fs';

/**
 * Env vars Frink's Claude auth model depends on, checked as literals in the downloaded binary
 * because the version floats and a release could drop any of them silently:
 * - CLAUDE_SECURESTORAGE_CONFIG_DIR points the CLI at the canonical keychain login so it
 *   refreshes its own token (docs/decisions/claude-credential-ownership-at-spawn.md).
 * - The *_FILE_DESCRIPTOR pair is how a stored credential reaches the CLI without sitting in the
 *   env its Bash commands and MCP servers inherit (docs/decisions/child-process-env-secrets.md).
 */
export const REQUIRED_CLAUDE_BINARY_ENV = [
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
];

/**
 * The needles absent from the file, in input order. One chunked pass with an overlap, so a needle
 * can't straddle a buffer boundary.
 */
export function findMissingLiterals(filePath, needles, chunkSize = 8 * 1024 * 1024) {
  const pending = new Map(needles.map((needle) => [needle, Buffer.from(needle, 'utf-8')]));
  const overlap = Math.max(...[...pending.values()].map((bytes) => bytes.length)) - 1;
  const buffer = Buffer.alloc(chunkSize);
  const fd = fs.openSync(filePath, 'r');
  try {
    let position = 0;
    let carry = Buffer.alloc(0);
    while (pending.size > 0) {
      const bytesRead = fs.readSync(fd, buffer, 0, chunkSize, position);
      if (bytesRead === 0) break;
      const window = Buffer.concat([carry, buffer.subarray(0, bytesRead)]);
      for (const [needle, bytes] of pending) if (window.includes(bytes)) pending.delete(needle);
      // Copy, don't alias: `buffer` is reused by the next readSync, so a subarray view
      // would be overwritten before it is concatenated — defeating the overlap guard.
      carry = Buffer.from(window.subarray(Math.max(0, window.length - overlap)));
      position += bytesRead;
    }
  } finally {
    fs.closeSync(fd);
  }
  return needles.filter((needle) => pending.has(needle));
}
