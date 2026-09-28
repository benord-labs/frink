import { z } from 'zod';
import type { AgentUserQuestion } from '../task-signal';

const id = z.string().min(1).max(200);
/** Per message, matching the desktop composer's image cap plus room for files. */
export const MOBILE_MAX_ATTACHMENTS = 10;
const chatIdentity = { chatId: id, subChatId: id };
export const mobileRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('overview') }),
  z.object({ type: z.literal('flows') }),
  z.object({ type: z.literal('flow'), id }),
  z.object({ type: z.literal('run'), id }),
  z.object({ type: z.literal('startFlow'), id, requestId: z.uuid() }),
  z.object({ type: z.literal('setFlowEnabled'), id, enabled: z.boolean() }),
  z.object({ type: z.literal('cancelRun'), id }),
  z.object({
    type: z.literal('resumeNode'),
    runId: id,
    nodeRunId: id,
    actionToken: z.string().regex(/^[a-f0-9]{64}$/),
    action: z.enum(['approve', 'skip']),
  }),
  z.object({ type: z.literal('chats') }),
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
  }),
  z.object({
    type: z.literal('sendMessage'),
    ...chatIdentity,
    requestId: z.uuid(),
    // May be empty when the message is only attachments; the bridge requires one or the other.
    text: z.string().trim().max(32000),
    attachments: z.array(id).max(MOBILE_MAX_ATTACHMENTS).optional(),
  }),
  z.object({ type: z.literal('composer'), ...chatIdentity }),
  z.object({
    type: z.literal('updateComposer'),
    ...chatIdentity,
    patch: z
      .object({
        modelId: id.optional(),
        autoMode: z.boolean().optional(),
        codexFastMode: z.boolean().optional(),
        thinkingEnabled: z.boolean().optional(),
      })
      .strict(),
  }),
  z.object({
    type: z.literal('setMode'),
    ...chatIdentity,
    mode: z.enum(['agent', 'plan', 'debug']),
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
  section: 'attention' | 'inbox' | 'running';
  chatId: string | null;
  subChatId: string | null;
  flowRunId: string | null;
};
export type MobileOverview = {
  machineName: string;
  executionReady: boolean;
  queue: MobileQueueItem[];
  questions: MobileQuestion[];
  permissions: MobilePermission[];
};
export type MobileFlow = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  trigger: string;
  latestRunId: string | null;
  status: string | null;
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
type MobileRunSummary = { id: string; status: string; startedAt: string | null };
export type MobileRunNode = {
  id: string;
  label: string;
  status: string;
  detail: string;
  chatId: string | null;
  subChatId: string | null;
  actions: Array<'approve' | 'skip'>;
  actionToken: string;
};
export type MobileRun = MobileRunSummary & {
  flowId: string;
  flowName: string;
  nodes: MobileRunNode[];
};
type MobileChat = { id: string; name: string; projectId: string | null };
export type MobileMessagePart =
  | { type: 'text'; text: string }
  | {
      type: 'tool';
      id: string;
      name: string;
      state: 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown';
    }
  | { type: 'attachment'; kind: 'image' | 'file'; name: string };
export type MobileMessage = {
  id: string;
  role: string;
  text: string;
  parts?: MobileMessagePart[];
};
export type MobileChatMode = 'agent' | 'plan' | 'debug';
/** A model picker row — the same fields the desktop picker groups by (family, window, effort). */
export type MobilePickerModel = {
  id: string;
  name: string;
  version?: string;
  detail?: string;
  familyId: string;
  contextLabel: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  effortDefault?: true;
  contextDefault?: true;
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
    codexFastMode: boolean;
    thinkingEnabled: boolean;
  };
  /** Empty when Auto can be used with this account and model. */
  autoUnavailableReason: string;
  /** Credit multiplier for Codex Fast on the selected model; null = no Fast tier. */
  codexFastCredits: number | null;
  /** The bundled Claude CLI accepts the Extra High effort. */
  xhighSupported: boolean;
};
export type MobileAttachment = { id: string; kind: 'image' | 'file'; name: string; size: number };
export type MobileChatDetail = {
  chat: MobileChat;
  subChatId: string;
  subChats: Array<{ id: string; name: string }>;
  messages: MobileMessage[];
  hasMore: boolean;
  active: boolean;
  error: string | null;
  questions: MobileQuestion[];
  permissions: MobilePermission[];
};
export type MobileResponses = {
  overview: MobileOverview;
  flows: MobileFlow[];
  flow: { flow: MobileFlow; runs: MobileRunSummary[]; definition: MobileFlowDefinition | null };
  run: MobileRun;
  startFlow: { id: string };
  setFlowEnabled: { ok: true };
  cancelRun: { ok: true };
  resumeNode: { ok: true };
  chats: MobileChat[];
  projects: Array<{ id: string; name: string }>;
  chat: MobileChatDetail;
  createChat: { chatId: string; subChatId: string };
  sendMessage: { ok: true };
  stopChat: { ok: true };
  deleteChat: { ok: true };
  answerQuestion: { ok: true };
  respondPermission: { ok: true };
  composer: MobileComposer;
  updateComposer: MobileComposer;
  setMode: MobileComposer;
  setAccount: MobileComposer;
};

export const MOBILE_API_VERSION = 1;
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
