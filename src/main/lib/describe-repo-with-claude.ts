/**
 * Generate a short project description by invoking Claude Code.
 * Claude can read the README or explore the codebase. Used for git projects on sync.
 */

import log from 'electron-log';
import { buildOneShotClaudeLaunch, getBundledClaudeBinaryPath } from './claude';
import {
  type CredentialResult,
  getDescriptionCredentialAttempts,
  isResolvedCredential,
  MAX_DESCRIPTION_ACCOUNT_ATTEMPTS,
} from './credentials';
import { allowReadOnlyUnderProject } from './describe-repo-permission';

const MAX_DESCRIPTION_LENGTH = 500;
const DESCRIBE_TIMEOUT_MS = 90_000;

const DESCRIBE_PROMPT = `Summarize this repository in 1-2 sentences for search. Prefer the README if present; otherwise briefly explore key files (e.g. package.json, README). Output only the summary, no preamble or quotes.`;

/** Extract text from SDK stream messages (stream_event deltas and assistant content blocks). */
function extractTextFromMessage(msg: unknown): string {
  let text = '';
  const m = msg as Record<string, unknown>;
  if (m.event && typeof m.event === 'object') {
    const ev = m.event as Record<string, unknown>;
    const delta = ev.delta as Record<string, unknown> | undefined;
    if (delta?.text && typeof delta.text === 'string') text += delta.text;
  }
  if (m.message && typeof m.message === 'object') {
    const content = (m.message as Record<string, unknown>).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          block &&
          typeof block === 'object' &&
          'text' in block &&
          typeof (block as { text: unknown }).text === 'string'
        ) {
          text += (block as { text: string }).text;
        }
      }
    }
  }
  return text;
}

/**
 * Generate a project description by running Claude with a single prompt.
 * Claude can use Read/Glob to read README or explore the codebase.
 * Returns null if no credentials or on timeout/error (caller can fall back to heuristics).
 */
export async function generateProjectDescriptionWithClaude(projectPath: string): Promise<{
  description: string | null;
  warning: string | null;
  attemptsTried: number;
}> {
  const attempts = await getDescriptionCredentialAttempts();
  if (attempts.length === 0) {
    return {
      description: null,
      warning:
        'Could not generate a project description because no authenticated AI accounts are available.',
      attemptsTried: 0,
    };
  }

  const cappedAttempts = attempts.slice(0, MAX_DESCRIPTION_ACCOUNT_ATTEMPTS);
  const attemptFailures: string[] = [];

  for (let index = 0; index < cappedAttempts.length; index += 1) {
    const credential = cappedAttempts[index];
    if (!credential || !isResolvedCredential(credential)) continue;

    const result = await generateProjectDescriptionWithClaudeCredential(projectPath, credential);
    if (result) {
      return { description: result, warning: null, attemptsTried: index + 1 };
    }
    attemptFailures.push(`attempt ${index + 1}: claude failed`);
  }

  const attemptsTried = cappedAttempts.length;
  log.warn('[describe-repo] Description generation failed for all attempts', {
    attemptsTried,
    failures: attemptFailures,
  });

  return {
    description: null,
    warning:
      `Could not generate a project description automatically after ${attemptsTried} attempt(s). ` +
      'You can still use the project and edit the description later in Settings.',
    attemptsTried,
  };
}

async function generateProjectDescriptionWithClaudeCredential(
  projectPath: string,
  credential: CredentialResult,
): Promise<string | null> {
  if (!isResolvedCredential(credential)) return null;

  const launch = buildOneShotClaudeLaunch(credential);

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), DESCRIBE_TIMEOUT_MS);

  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const stream = sdk.query({
      prompt: DESCRIBE_PROMPT,
      options: {
        abortController,
        cwd: projectPath,
        ...launch,
        // Same binary the executor spawns — and the only one download-claude-binary.mjs
        // asserts CLAUDE_SECURESTORAGE_CONFIG_DIR support on. Without this the SDK picks
        // its own bundled CLI, where the pin above could silently be a no-op.
        pathToClaudeCodeExecutable: getBundledClaudeBinaryPath(),
        systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const },
        permissionMode: 'default' as const,
        includePartialMessages: false,
        canUseTool: async (
          toolName: string,
          toolInput: Record<string, unknown>,
        ): Promise<
          | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
          | { behavior: 'deny'; message: string }
        > => {
          const result = allowReadOnlyUnderProject(projectPath, toolName, toolInput);
          return result.allowed
            ? { behavior: 'allow', updatedInput: toolInput }
            : { behavior: 'deny', message: result.message ?? 'Not allowed.' };
        },
      },
    });

    let accumulated = '';
    for await (const msg of stream) {
      if (abortController.signal.aborted) break;
      accumulated += extractTextFromMessage(msg);
    }

    const trimmed = accumulated.trim();
    return trimmed ? trimmed.slice(0, MAX_DESCRIPTION_LENGTH) : null;
  } catch (error) {
    log.warn('[describe-repo] Claude description failed:', error);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
