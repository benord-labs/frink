import { z } from 'zod';
import { CODEX_SPEEDS, type CodexSpeed } from '../execution';
import type { AgentUserQuestion } from '../task-signal';

const id = z.string().min(1).max(200);
/** Per message, matching the desktop composer's image cap plus room for files. */
export const MOBILE_MAX_ATTACHMENTS = 10;
const chatIdentity = { chatId: id, subChatId: id };
/** Lists are a growing window: the phone re-polls the first `limit` rows and raises it to see more. */
const listLimit = z.number().int().min(1).max(200);
const MOBILE_CHAT_MODES = ['agent', 'plan', 'debug'] as const;
export const mobileRequestSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('overview'),
    limits: z
      .object({
        attention: listLimit.optional(),
        running: listLimit.optional(),
        inbox: listLimit.optional(),
      })
      .strict()
      .optional(),
  }),
  z.object({ type: z.literal('flows') }),
  z.object({ type: z.literal('flow'), id, runLimit: z.number().int().min(1).max(100).optional() }),
  z.object({ type: z.literal('run'), id }),
  z.object({ type: z.literal('startFlow'), id, requestId: z.uuid() }),
  z.object({ type: z.literal('setFlowEnabled'), id, enabled: z.boolean() }),
  z.object({ type: z.literal('cancelRun'), id }),
  // A Queue task's row actions, gated on the computer by the desktop Work Queue's own rules.
  z.object({ type: z.literal('completeTask'), id }),
  z.object({ type: z.literal('continueTask'), id }),
  z.object({ type: z.literal('startTask'), id }),
  z.object({
    type: z.literal('resumeNode'),
    runId: id,
    nodeRunId: id,
    actionToken: z.string().regex(/^[a-f0-9]{64}$/),
    action: z.enum(['approve', 'skip']),
  }),
  z.object({
    type: z.literal('chats'),
    limit: listLimit.optional(),
    // Matched on the computer against chat and project names, so search covers every chat.
    query: z.string().trim().max(100).optional(),
  }),
  z.object({ type: z.literal('projects') }),
  z.object({
    type: z.literal('chat'),
    id,
    subChatId: id.optional(),
    beforeMessageId: id.optional(),
  }),
  z.object({
    type: z.literal('createChat'),
    projectId: id,
    // Omitted when the phone starts a chat from its first message; the computer names it from that.
    name: z.string().trim().min(1).max(100).optional(),
    // False works in the project folder itself, like desktop's Local mode. Older phones omit it.
    useWorktree: z.boolean().optional(),
    mode: z.enum(MOBILE_CHAT_MODES).optional(),
  }),
  z.object({
    type: z.literal('sendMessage'),
    ...chatIdentity,
    requestId: z.uuid(),
    // May be empty when the message is only attachments; the bridge requires one or the other.
    text: z.string().trim().max(32000),
    attachments: z.array(id).max(MOBILE_MAX_ATTACHMENTS).optional(),
  }),
  // Joins the running turn at its next step (desktop's Steer); never starts a turn.
  z.object({
    type: z.literal('steerMessage'),
    ...chatIdentity,
    requestId: z.uuid(),
    text: z.string().trim().min(1).max(32000),
  }),
  z.object({ type: z.literal('composer'), ...chatIdentity }),
  z.object({
    type: z.literal('updateComposer'),
    ...chatIdentity,
    patch: z
      .object({
        modelId: id.optional(),
        autoMode: z.boolean().optional(),
        codexSpeed: z.enum(CODEX_SPEEDS).optional(),
        thinkingEnabled: z.boolean().optional(),
      })
      .strict(),
  }),
  z.object({
    type: z.literal('setMode'),
    ...chatIdentity,
    mode: z.enum(MOBILE_CHAT_MODES),
  }),
  z.object({ type: z.literal('setAccount'), ...chatIdentity, accountId: id.nullable() }),
  z.object({ type: z.literal('stopChat'), ...chatIdentity }),
  z.object({ type: z.literal('deleteChat'), chatId: id }),
  z.object({
    type: z.literal('answerQuestion'),
    ...chatIdentity,
    id,
    source: z.enum(['live', 'parked']),
    requestId: z.uuid(),
    answers: z.record(z.string().max(4000), z.string().trim().min(1).max(8000)),
  }),
  z.object({
    type: z.literal('respondPermission'),
    ...chatIdentity,
    requestId: id,
    approved: z.boolean(),
  }),
  // Desktop's Approve: starts building from the plan awaiting review, which must still be `planId`.
  z.object({ type: z.literal('approvePlan'), ...chatIdentity, planId: id, requestId: z.uuid() }),
]);

export type MobileRequest = z.infer<typeof mobileRequestSchema>;
export type MobileQuestion = {
  id: string;
  source: 'live' | 'parked';
  chatId: string;
  subChatId: string;
  title: string;
  questions: AgentUserQuestion[];
};
export type MobilePermission = {
  requestId: string;
  chatId: string;
  subChatId: string;
  title: string;
  description: string;
  supported: boolean;
};
export type MobileQueueItem = {
  id: string;
  title: string;
  summary: string;
  status: string;
  section: MobileQueueSection;
  chatId: string | null;
  subChatId: string | null;
  flowRunId: string | null;
  projectName: string | null;
  /** Latest of completion, start or creation: when this item last changed state. */
  activityAt: string;
  /** The row actions the phone may send; a Flow item starts and carries on through its run. */
  actions: MobileTaskAction[];
};
export type MobileTaskAction = 'startTask' | 'continueTask' | 'completeTask';
export type MobileQueueSection = 'attention' | 'inbox' | 'running';
/** Chats counted once each: needing the user wins over running. */
export type MobileAgentCounts = { running: number; needsYou: number };
export type MobileOverview = {
  machineName: string;
  executionReady: boolean;
  /** Frink's version on the computer. */
  appVersion: string;
  queue: MobileQueueItem[];
  /** Exact totals per section, independent of how many rows were sent. */
  counts: Record<MobileQueueSection, number>;
  more: Record<MobileQueueSection, boolean>;
  questions: MobileQuestion[];
  permissions: MobilePermission[];
  agents: MobileAgentCounts;
};
export type MobileFlow = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  trigger: string;
  latestRunId: string | null;
  /** Status of the live run, if one is running or paused. */
  status: string | null;
  /** The most recent run of any status. */
  lastRun: { id: string; status: string; at: string } | null;
};
/** The current saved definition, independent of any historical run's graph. */
export type MobileFlowDefinition = {
  versionNumber: number;
  nodes: Array<{
    id: string;
    label: string;
    blockType: string;
    parentId: string | null;
    instructions: string | null;
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    label: string | null;
    sourceHandle: string | null;
  }>;
};
type MobileRunSummary = {
  id: string;
  status: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};
export type MobileRunNode = {
  id: string;
  label: string;
  status: string;
  detail: string;
  chatId: string | null;
  subChatId: string | null;
  actions: Array<'approve' | 'skip'>;
  actionToken: string;
  startedAt: string | null;
  completedAt: string | null;
};
export type MobileRun = MobileRunSummary & {
  flowId: string;
  flowName: string;
  nodes: MobileRunNode[];
};
type MobileChat = { id: string; name: string; projectId: string | null };
/** `background` is a turn parked on background work (a Monitor or Command): desktop's static
 *  "Background" state, which does not count as running. */
export type MobileActivity = 'running' | 'background' | 'idle';
/** A chat list row; `activity` is the busiest of its conversations. */
export type MobileChatSummary = MobileChat & {
  activity: MobileActivity;
  /** `flow` when the chat is a Flow run's step; manual tasks and ordinary chats are `chat`. */
  kind: 'chat' | 'flow';
  /** Last activity (messages, mode or session changes) in any of its conversations. */
  lastActiveAt: string;
  projectName: string | null;
};
export type MobileProject = { id: string; name: string; lastActiveAt: string | null };
export type MobilePage<T> = { items: T[]; hasMore: boolean };
export type MobileMessagePart =
  | { type: 'text'; text: string }
  | {
      type: 'tool';
      id: string;
      name: string;
      state: 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown';
    }
  | { type: 'attachment'; kind: 'image' | 'file'; name: string }
  /** A message the user steered into the running turn. */
  | { type: 'steer'; text: string }
  /** A plan Frink wrote for review, as markdown. */
  | { type: 'plan'; id: string; text: string };
export type MobileMessage = {
  id: string;
  role: string;
  text: string;
  parts?: MobileMessagePart[];
};
export type MobileChatMode = (typeof MOBILE_CHAT_MODES)[number];
/** A model picker row — the same fields the desktop picker groups by (family, window, effort). */
export type MobilePickerModel = {
  id: string;
  name: string;
  version?: string;
  detail?: string;
  familyId: string;
  contextLabel: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  effortDefault?: true;
  contextDefault?: true;
  /** Claude: this row runs Ultra (parallel agents) at its effort. */
  ultra?: true;
};
export type MobileAccount = {
  id: string;
  label: string;
  type: string;
  isDefault: boolean;
  isAuthenticated: boolean;
};
/** Everything the phone composer shows: the chat's settings (owned by the computer) + choices. */
export type MobileComposer = {
  mode: MobileChatMode;
  /** Debug needs a project, as on desktop. */
  debugAvailable: boolean;
  provider: 'claude' | 'codex';
  account: {
    id: string | null;
    label: string;
    type: string;
    isAuthenticated: boolean;
    isProjectOverride: boolean;
  } | null;
  /** The chat's project; account switches are scoped to it (null = changes the default). */
  projectId: string | null;
  accounts: MobileAccount[];
  /** The provider's picker rows, filtered to what the desktop picker shows. */
  models: MobilePickerModel[];
  settings: {
    modelId: string;
    autoMode: boolean;
    codexSpeed: CodexSpeed;
    thinkingEnabled: boolean;
  };
  /** Empty when Auto can be used with this account and model. */
  autoUnavailableReason: string;
  /** Credit multiplier of each paid Codex speed on the selected model; null = not offered. */
  codexSpeedCredits: Record<Exclude<CodexSpeed, 'standard'>, number | null>;
  /** The bundled Claude CLI accepts the Extra High effort. */
  xhighSupported: boolean;
  /** The bundled Claude CLI runs Ultra at any effort. */
  ultraSupported: boolean;
};
export type MobileAttachment = { id: string; kind: 'image' | 'file'; name: string; size: number };
export type MobileChatDetail = {
  chat: MobileChat;
  subChatId: string;
  subChats: Array<{ id: string; name: string; activity: MobileActivity }>;
  messages: MobileMessage[];
  hasMore: boolean;
  /** The selected conversation's activity. */
  activity: MobileActivity;
  /** `flow` when the conversation is a Flow run's step; stopping it ends the whole run. */
  kind: 'chat' | 'flow';
  error: string | null;
  questions: MobileQuestion[];
  permissions: MobilePermission[];
  /** The plan waiting for Approve or Send back; null once decided, or when a Flow run owns it. */
  pendingPlanId: string | null;
};
export type MobileResponses = {
  overview: MobileOverview;
  flows: MobileFlow[];
  flow: {
    flow: MobileFlow;
    runs: MobilePage<MobileRunSummary>;
    definition: MobileFlowDefinition | null;
  };
  run: MobileRun;
  startFlow: { id: string };
  setFlowEnabled: { ok: true };
  cancelRun: { ok: true };
  completeTask: { ok: true };
  continueTask: { ok: true };
  startTask: { ok: true };
  resumeNode: { ok: true };
  chats: MobilePage<MobileChatSummary>;
  /** Most recently active first. */
  projects: MobileProject[];
  chat: MobileChatDetail;
  createChat: { chatId: string; subChatId: string };
  sendMessage: { ok: true };
  /** Not delivered when the turn can't take a message right now; the phone keeps it as a draft. */
  steerMessage: { outcome: 'delivered' | 'not-delivered' };
  stopChat: { ok: true };
  deleteChat: { ok: true };
  answerQuestion: { ok: true };
  respondPermission: { ok: true };
  approvePlan: { ok: true };
  composer: MobileComposer;
  updateComposer: MobileComposer;
  setMode: MobileComposer;
  setAccount: MobileComposer;
};

export const MOBILE_API_VERSION = 2;
export const MOBILE_PORT = 43129;
export const mobilePairingSchema = z.object({
  version: z.literal(MOBILE_API_VERSION),
  url: z.url().refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
    );
  }, 'Use the private HTTPS address of your computer.'),
  code: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
/** The pairing QR is this link, so the iPhone Camera can open Frink straight onto confirming the Mac. */
export const MOBILE_PAIRING_LINK = 'frink-mobile://pair';
export function mobilePairingLink({
  version,
  url,
  code,
}: z.infer<typeof mobilePairingSchema>): string {
  return `${MOBILE_PAIRING_LINK}?${new URLSearchParams({ url, code, v: String(version) })}`;
}
/** The unvalidated fields of a pairing code in either form: the link above, or its JSON. */
export function mobilePairingFields(text: string): unknown {
  const link = `${MOBILE_PAIRING_LINK}?`;
  if (!text.startsWith(link)) return JSON.parse(text);
  const params = new URLSearchParams(text.slice(link.length));
  // `v` comes last, so a cut-off link has no version rather than a wrong one.
  const v = params.get('v');
  return { version: v ? Number(v) : undefined, url: params.get('url'), code: params.get('code') };
}
