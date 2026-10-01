/**
 * Chat-name generation (single main-process pipeline).
 *
 * `autoNameSubChat` is the one entry point that names a sub-chat (and, for the
 * first sub-chat, its parent) from the first user message. It is fired from two
 * thin sites: chat-create (create.ts) and the first-user-message persist hook
 * (socket/client.ts). It only acts on a sub-chat whose name is still null, so
 * task/flow chats (seeded with a non-null name) are skipped automatically.
 * It performs no work on the renderer; the resulting name reaches the UI via
 * the `chats:name-updated` broadcast.
 *
 * Credential routing follows the same priority the executor uses, gating the
 * project-assigned account on the shared `isResolvedCredential` predicate so this
 * path can't drift from the executor on what counts as authenticated:
 *   1. Project-assigned account (if `projectId` is set), when resolvable
 *   2. Workspace default credential
 *
 * Only a Claude account names via the Agent SDK; otherwise a chat keeps its deterministic name
 * and a build project keeps its placeholder.
 */

import { tmpdir } from 'node:os';
import { BrowserWindow } from 'electron';
import log from 'electron-log';
import { stripMessageMarkers } from '../../../../../../shared/lib/message-markers/strip-message-markers';
import { parseTriggerBubbleMessage } from '../../../../../../shared/lib/trigger-bubble-marker';
import { BUILD_PROJECT_PLACEHOLDER, isManagedBuildPath } from '../../../../builds-path';
import { buildOneShotClaudeLaunch, getBundledClaudeBinaryPath } from '../../../../claude/env';
import { claudeErrorText } from '../../../../claude/stream-classifiers';
import {
  type CredentialResult,
  getClaudeCodeTokenById,
  getDefaultClaudeCodeToken,
  isResolvedCredential,
} from '../../../../credentials';
import { getDatabase } from '../../../../db';
import { getChatById, updateChat as updateChatLocal } from '../../../../db/repos/chats';
import { getProjectAiAccount } from '../../../../db/repos/project-ai-accounts';
import {
  getProjectById,
  listProjects,
  renameProjectIfPlaceholder,
} from '../../../../db/repos/projects';
import {
  getSubChatById,
  renameSubChat as renameSubChatLocal,
} from '../../../../db/repos/sub-chats';
import { captureContained } from '../../../../sentry';
import { cleanGeneratedName, isMultiWord, tidyToTitle } from './clean-name';
import { getFallbackName } from './fallbacks';
import { frinkUserHome } from '../../../../platform/frink-home';

const NAME_GEN_TIMEOUT_MS = 15_000;

// Bound the project re-naming LLM calls: only attempt for the first N user messages of a
// still-placeholder build (the goal is stated early). Past this, the build stays "New project"
// and the sidebar Rename hatch covers it. The name===placeholder gate stops attempts globally
// the instant any message names the project.
const PROJECT_NAME_REATTEMPT_MAX = 5;

/**
 * Whether to attempt naming a still-placeholder build from this sub-chat's Nth user message.
 * Attempts on messages 1..MAX (so the goal-in-message-2 case is caught — NOT capped at message 1),
 * skips past the cap and on an empty count. The cap is keyed per sub-chat; the `name===placeholder`
 * gate in `maybeNameBuildProjectFromMessage` is what stops attempts globally once any message names it.
 */
export function shouldReattemptProjectName(userMessageCount: number): boolean {
  return userMessageCount > 0 && userMessageCount <= PROJECT_NAME_REATTEMPT_MAX;
}

function normalizeName(name: string | null | undefined): string {
  return (name ?? '').trim();
}

/**
 * Derive the text to name from. Trigger-bubble messages carry a richer subject
 * in their marker, so prefer that over the raw prompt.
 */
function deriveNameSource(rawUserMessage: string): string {
  const { triggerData, fullPrompt } = parseTriggerBubbleMessage(rawUserMessage);
  if (triggerData) {
    return triggerData.title || fullPrompt;
  }
  return stripMessageMarkers(rawUserMessage);
}

function buildPrompt(userMessage: string): string {
  return `Generate a short title (2 to 5 words) for a coding chat that starts with this message. The title MUST be at least two words — never reply with a single word. Only output the title, nothing else. No quotes, no explanations.

User message: "${userMessage.slice(0, 500)}"

Title:`;
}

// Project-INTENT prompt — names what the user wants to BUILD, and ABSTAINS (NONE) on chit-chat.
// A project name is not a chat title: "hello" must yield NONE (keep the placeholder), not a
// conversation summary like "Friendly Greeting".
function projectNamePrompt(userMessage: string): string {
  return `Name the software project this person wants to BUILD, in 2-4 words (Title Case). If they have NOT said what to build yet — a greeting, a question, small talk, or anything that isn't a concrete build request — reply with exactly one word: NONE. Output ONLY the project name, or NONE. No preamble, no quotes.

User message: "${userMessage.slice(0, 500)}"

Project name:`;
}

// True when the cleaned model output is an abstention ("NONE", "None.", "Project: NONE", …).
const ABSTAIN_PREFIX_RE = /^\s*(project|name)\s*:\s*/i;
const ABSTAIN_RE = /^none\b/i;
function isAbstention(candidate: string | null): boolean {
  if (!candidate) return true;
  return ABSTAIN_RE.test(candidate.replace(ABSTAIN_PREFIX_RE, '').trim());
}

export function broadcastChatNameUpdated(chatId: string, subChatId: string, name: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('chats:name-updated', { chatId, subChatId, name });
    }
  }
}

function broadcastProjectNameUpdated(projectId: string, name: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('projects:name-updated', { projectId, name });
    }
  }
}

/**
 * A display name unique among `taken`, appending " 2", " 3"… on collision. Project names (unlike
 * folder paths) carry no UNIQUE constraint, so this is best-effort dedup to keep the sidebar
 * unambiguous — two builds the LLM titles the same ("test", "test") become "test", "test 2".
 */
export function uniqueProjectName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Name a gitless BUILD project from a user message — fired on EVERY user message until the project
 * gets a real name. Decoupled from chat naming: uses the build-INTENT prompt and ABSTAINS on
 * chit-chat (so "hello" keeps the "New project" placeholder; the goal in a later message names it).
 * Self-gated:
 *   - the project must still be the `BUILD_PROJECT_PLACEHOLDER` (stops globally the instant it's named),
 *   - and a Frink-managed build path (a real repo is skipped).
 * Looks up `project.path` itself (no caller-threaded path), so it works from the socket message path
 * too. The write is placeholder-CONDITIONAL (`renameProjectIfPlaceholder`), so the create.ts + socket
 * double-fire on the first message collapses to one rename + one broadcast. Fire-and-forget; never throws.
 */
export async function maybeNameBuildProjectFromMessage(
  projectId: string | null,
  userMessage: string,
): Promise<void> {
  if (!projectId) return;
  try {
    const db = getDatabase();
    const project = await getProjectById(db, projectId);
    if (!project || project.name !== BUILD_PROJECT_PLACEHOLDER) return;
    if (!isManagedBuildPath(project.path, frinkUserHome())) return;

    const resolved = await resolveProjectNameViaAi({
      // Runs on later messages too (shouldReattemptProjectName), so this can be a marked
      // question-answer / trigger message — the naming prompt must see prose only.
      userMessage: stripMessageMarkers(userMessage),
      projectId,
      projectPath: project.path,
    });
    if (!resolved) return; // abstain / AI fail → keep placeholder, retry on a later message

    // Dedup against other projects' display names (excl. self + still-placeholder builds).
    const taken = new Set(
      (await listProjects(db))
        .filter((p) => p.id !== projectId && p.name !== BUILD_PROJECT_PLACEHOLDER)
        .map((p) => p.name),
    );
    const uniqueName = uniqueProjectName(resolved, taken);
    // Conditional write: renames only a row still at the placeholder, so a concurrent double-fire
    // settles to one name (the loser changes 0 rows → skips the broadcast).
    const updated = await renameProjectIfPlaceholder(
      db,
      projectId,
      uniqueName,
      BUILD_PROJECT_PLACEHOLDER,
    );
    if (updated) broadcastProjectNameUpdated(projectId, uniqueName);
  } catch (err) {
    log.warn('[chat-name] build-project rename failed', err);
  }
}

async function resolveCredentialForProject(
  projectId: string | null,
): Promise<CredentialResult | null> {
  try {
    if (projectId) {
      const account = await getProjectAiAccount(getDatabase(), projectId);
      if (account) {
        const cred = await getClaudeCodeTokenById(account.id);
        // Honour a resolvable assigned account (codex is token-null by design) instead of the
        // default Claude account; an UNRESOLVED one (mid-reauth claude-code) falls through to default.
        if (isResolvedCredential(cred)) return cred;
      }
    }
    const fallback = await getDefaultClaudeCodeToken();
    return isResolvedCredential(fallback) ? fallback : null;
  } catch (err) {
    log.warn('[chat-name] credential resolution failed', err);
    return null;
  }
}

async function generateWithClaudeSdk(
  userMessage: string,
  credential: CredentialResult,
  cwd: string,
  prompt: string = buildPrompt(userMessage),
  model = 'haiku',
): Promise<string | null> {
  if (!isResolvedCredential(credential)) return null;

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), NAME_GEN_TIMEOUT_MS);

  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const launch = buildOneShotClaudeLaunch(credential);

    const stream = sdk.query({
      prompt,
      options: {
        abortController,
        cwd,
        ...launch,
        // Same binary the executor spawns — and the only one download-claude-binary.mjs
        // asserts CLAUDE_SECURESTORAGE_CONFIG_DIR support on. Without this the SDK picks
        // its own bundled CLI, where the pin above could silently be a no-op.
        pathToClaudeCodeExecutable: getBundledClaudeBinaryPath(),
        // Naming is a one-shot completion, not an agent run. These keep it fast:
        // a small model, no filesystem settings/CLAUDE.md discovery, and the
        // preset prompt with its heavy per-user dynamic sections excluded.
        // (excludeDynamicSections has no effect unless the preset is used, so we
        // keep the preset rather than a fully custom string — also preserves the
        // build-intent abstention the project-name path relies on.)
        model,
        settingSources: [],
        // Ephemeral + isolated: no transcript on disk (keeps throwaway naming runs out of the user's ~/.claude/projects session
        // picker), and no hooks fire for a background naming call.
        persistSession: false,
        settings: { disableAllHooks: true },
        systemPrompt: { type: 'preset', preset: 'claude_code', excludeDynamicSections: true },
        permissionMode: 'default' as const,
        includePartialMessages: false,
        canUseTool: async () => ({ behavior: 'deny', message: 'Tools disabled for naming.' }),
      },
    });

    let accumulated = '';
    for await (const msg of stream) {
      if (abortController.signal.aborted) break;
      const m = msg as Record<string, unknown>;
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
              accumulated += (block as { text: string }).text;
            }
          }
        }
      }
    }
    clearTimeout(timer);
    return cleanGeneratedName(accumulated);
  } catch (err) {
    clearTimeout(timer);
    log.warn('[chat-name] Claude SDK failed', claudeErrorText(err));
    return null;
  }
}

type ResolveChatNameInput = {
  userMessage: string;
  projectId: string | null;
  projectPath: string | null;
};

/** Resolve a chat name via the chat's own Claude account; null when that fails, so the caller
 * applies its deterministic fallback. No DB writes. */
async function resolveChatNameViaAi(input: ResolveChatNameInput): Promise<string | null> {
  const cwd = input.projectPath ?? tmpdir();
  const credential = await resolveCredentialForProject(input.projectId);
  // `codex` is excluded on purpose: resolvable, but NOT a Claude account. claude-passthrough IS
  // resolvable with a null token (the SDK reads the keychain), so token presence is the wrong gate.
  if (credential && credential.type !== 'codex' && isResolvedCredential(credential)) {
    return generateWithClaudeSdk(input.userMessage, credential, cwd);
  }
  return null;
}

/** Resolve a PROJECT name via the project's Claude account with the build-INTENT prompt; null on
 * failure OR abstention keeps the placeholder (no message-slice fallback). No DB writes. */
async function resolveProjectNameViaAi(input: ResolveChatNameInput): Promise<string | null> {
  const cwd = input.projectPath ?? tmpdir();
  const credential = await resolveCredentialForProject(input.projectId);
  const prompt = projectNamePrompt(input.userMessage);
  let name: string | null = null;
  // See resolveChatNameViaAi for why codex is excluded and token presence isn't the gate.
  // Keep the stronger model: the build-intent abstention (reply NONE on chit-chat) is the
  // load-bearing behavior of build-project-display-naming.
  if (credential && credential.type !== 'codex' && isResolvedCredential(credential)) {
    name = await generateWithClaudeSdk(input.userMessage, credential, cwd, prompt, 'sonnet');
  }
  return isAbstention(name) ? null : name;
}

export type AutoNameSubChatInput = {
  chatId: string;
  subChatId: string;
  rawUserMessage: string;
  projectId: string | null;
  projectPath: string | null;
  isFirstSubChat: boolean;
};

/**
 * Name a sub-chat (and its parent, when it is the first sub-chat) from the
 * first user message. No-op when the sub-chat already has a name — this single
 * guard skips already-named, user-renamed, and task/flow chats (which are
 * seeded with a non-null name). Fire-and-forget; never throws.
 */
export async function autoNameSubChat(input: AutoNameSubChatInput): Promise<void> {
  const db = getDatabase();

  // Pre-write guard: only name a sub-chat that has no name yet. A read failure CONTAINS rather
  // than propagates — every caller invokes this detached (`void autoNameSubChat(...)`), so a
  // throw here surfaces as an unhandled rejection instead of a skipped rename. Matches the
  // re-read guard below. See docs/decisions/sub-chat-read-failure-posture.md.
  const existing = await getSubChatById(db, input.subChatId).catch((err) => {
    log.warn('[chat-name] pre-write guard read failed', err);
    // Detached caller, so this is the only place the fault can be seen at all.
    captureContained(err, { surface: 'chat-name', stage: 'pre-write-guard' });
    return null;
  });
  if (!existing || normalizeName(existing.name).length > 0) return;

  const messageForName = deriveNameSource(input.rawUserMessage);

  let resolvedName: string | null = null;
  try {
    resolvedName = await resolveChatNameViaAi({
      userMessage: messageForName,
      projectId: input.projectId,
      projectPath: input.projectPath,
    });
  } catch (err) {
    log.warn('[chat-name] generation failed', err);
  }

  // Always settle on a non-null name so the renderer's loading shimmer clears.
  // Best-effort ≥2 words on the AI branch: a single-word AI title is reshaped
  // into a short Title-Case phrase from the message (a title, never the
  // raw-message slice). A one-word message, or total AI failure (deterministic
  // fallback), can still yield a single word.
  const finalName =
    resolvedName == null
      ? getFallbackName(messageForName)
      : isMultiWord(resolvedName)
        ? resolvedName
        : tidyToTitle(messageForName) || resolvedName;

  try {
    // Re-read guard: a user manual-rename (or a concurrent namer) during the AI
    // latency window wins — don't clobber it.
    const fresh = await getSubChatById(db, input.subChatId);
    if (!fresh || normalizeName(fresh.name).length > 0) return;
    await renameSubChatLocal(db, input.subChatId, finalName);

    if (input.isFirstSubChat) {
      const parent = await getChatById(db, input.chatId);
      if (parent && normalizeName(parent.name).length === 0) {
        await updateChatLocal(db, input.chatId, { name: finalName });
      }
    }

    broadcastChatNameUpdated(input.chatId, input.subChatId, finalName);
  } catch (err) {
    log.warn('[chat-name] persist failed', err);
    // Same contain-and-log tier as the pre-write guard: still detached, so still invisible
    // without a capture. A rename that silently never lands looks like the feature is off.
    captureContained(err, { surface: 'chat-name', stage: 'persist' });
  }
}
