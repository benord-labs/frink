/**
 * Command Parser for Bash Permissions
 *
 * Uses shell-quote for semantic tokenization to extract command signatures.
 * Handles:
 * - Command chaining (&&, ||, ;, |)
 * - Flags before subcommands (git -C /path push -> git push)
 * - Quoted arguments
 *
 * Based on research R-133217 (Feb 2, 2026)
 */

import { type ParseEntry, parse } from 'shell-quote';
import { TRAILING_WILDCARD_REGEX } from '../../../shared/lib/bash-patterns';

// ============================================================================
// Types
// ============================================================================

export type CommandSignature = {
  /** Base command (e.g., "git", "find", "npm") */
  base: string;
  /** Subcommand if detected (e.g., "push", "run") */
  subcommand?: string;
  /** Full signature for display (e.g., "git push", "find") */
  fullSignature: string;
};

/**
 * Known flags that take a value argument (for git-style commands).
 * When we see these flags, we skip the next token too.
 */
const FLAGS_WITH_VALUES = new Set([
  // Git flags
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  // Common flags
  '-o',
  '--output',
  '-f',
  '--file',
]);

/**
 * Parse a single command (no operators) into a signature.
 * Extracts the base command and first non-flag token as subcommand.
 */
function parseTokensToSignature(tokens: string[]): CommandSignature {
  if (tokens.length === 0) {
    return { base: '', fullSignature: '' };
  }

  const base = tokens[0];

  // Find first non-flag token after base (the subcommand)
  let subcommand: string | undefined;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];

    // Skip flags
    if (token.startsWith('-')) {
      // If this flag takes a value, skip the next token too
      if (FLAGS_WITH_VALUES.has(token)) {
        i++; // Skip the value
      }
      continue;
    }

    // First non-flag token is the subcommand
    subcommand = token;
    break;
  }

  return {
    base,
    subcommand,
    fullSignature: subcommand ? `${base} ${subcommand}` : base,
  };
}

/**
 * Check if a ParseEntry is an operator (&&, ||, ;, |)
 */
function isOperator(entry: ParseEntry): boolean {
  return typeof entry === 'object' && entry !== null && 'op' in entry;
}

/**
 * Extract command signatures from a shell command string.
 * Handles compound commands by splitting on operators.
 *
 * @example
 * extractCommandSignatures("git add . && git push origin main")
 * // Returns: [{ base: "git", subcommand: "add", ... }, { base: "git", subcommand: "push", ... }]
 *
 * @example
 * extractCommandSignatures("git -C /path/to/repo push origin main")
 * // Returns: [{ base: "git", subcommand: "push", fullSignature: "git push" }]
 */
export function extractCommandSignatures(command: string): CommandSignature[] {
  const parsed = parse(command);
  const signatures: CommandSignature[] = [];

  let currentTokens: string[] = [];

  for (const entry of parsed) {
    // Handle operators - they mark the end of a command
    if (isOperator(entry)) {
      if (currentTokens.length > 0) {
        signatures.push(parseTokensToSignature(currentTokens));
        currentTokens = [];
      }
      continue;
    }

    // Handle string tokens
    if (typeof entry === 'string') {
      currentTokens.push(entry);
    }
    // Handle comment entries (ignore them)
    else if (typeof entry === 'object' && 'comment' in entry) {
    }
  }

  // Don't forget the last command
  if (currentTokens.length > 0) {
    signatures.push(parseTokensToSignature(currentTokens));
  }

  return signatures.filter((sig) => sig.base !== '');
}

// ============================================================================
// Pattern Generation
// ============================================================================

/**
 * Generate pattern choices for the user approval dialog.
 * Returns unique patterns from most specific to least specific.
 *
 * SECURITY: For piped/chained commands (e.g., `find . | xargs rm`), we generate
 * patterns for ALL unique commands, not just the first. This prevents a user
 * from approving "find *" and inadvertently allowing dangerous pipe targets.
 *
 * @example
 * generatePatternChoices([{ base: "git", subcommand: "push", ... }])
 * // Returns: ["git push *", "git *"]
 *
 * @example
 * // For "find . | grep foo | head -5", signatures would be [find, grep, head]
 * // Returns: ["find *", "grep *", "head *"] - user must approve each
 */
export function generatePatternChoices(signatures: CommandSignature[]): string[] {
  const choices = new Set<string>();

  if (signatures.length === 0) {
    return [];
  }

  // Generate patterns for ALL unique commands (security: don't skip pipe targets)
  for (const sig of signatures) {
    // Always offer base command pattern
    choices.add(`${sig.base} *`);

    // If there's a subcommand, offer that too (more specific)
    if (sig.subcommand) {
      choices.add(`${sig.base} ${sig.subcommand} *`);
    }
  }

  // Sort: more specific (with subcommand) first, then alphabetically
  return Array.from(choices).sort((a, b) => {
    const aWords = a.split(' ').length;
    const bWords = b.split(' ').length;
    if (bWords !== aWords) {
      return bWords - aWords; // More words = more specific = first
    }
    return a.localeCompare(b); // Alphabetical for same specificity
  });
}

// ============================================================================
// Pattern Matching
// ============================================================================

/**
 * Check if a single signature matches a pattern.
 */
function signatureMatchesPattern(sig: CommandSignature, pattern: string): boolean {
  const patternSig = pattern.replace(TRAILING_WILDCARD_REGEX, '');
  const patternParts = patternSig.split(' ');
  const patternBase = patternParts[0];
  const patternSubcommand = patternParts[1]; // May be undefined

  // Base must match
  if (sig.base !== patternBase) {
    return false;
  }

  // If pattern has subcommand, command must have matching subcommand
  if (patternSubcommand) {
    return sig.subcommand === patternSubcommand;
  }

  // Pattern is base-only (e.g., "git *"), matches any command with that base
  return true;
}

/**
 * Check if pre-parsed command signatures match a pattern.
 * Use this when checking multiple patterns against the same command to avoid re-parsing.
 *
 * Returns true if ANY command in the pipeline matches the pattern.
 * SECURITY NOTE: For piped commands like `find . | xargs rm`, you should check
 * that ALL commands have matching approved patterns before allowing execution.
 *
 * @param pattern - The pattern to match (e.g., "git push *")
 * @param signatures - Pre-parsed command signatures from extractCommandSignatures()
 */
export function signaturesMatchPattern(pattern: string, signatures: CommandSignature[]): boolean {
  if (signatures.length === 0) {
    return false;
  }

  // Check if ANY signature matches the pattern
  return signatures.some((sig) => signatureMatchesPattern(sig, pattern));
}
