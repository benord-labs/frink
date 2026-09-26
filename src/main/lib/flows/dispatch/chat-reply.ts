/**
 * chat_reply block — post a message into the originating chat session.
 *
 * Resolves chatId / subChatId from triggerContext (post_task_trigger fan-out)
 * or upstream agent / start_task outputs. Appends a synthesized assistant
 * message to the sub-chat's `messages` JSON. Renderer's existing chat
 * subscription picks the new message up on next refetch (live-stream is
 * out of scope; this is a post-hoc summary message).
 */

import { randomUUID } from 'node:crypto';
import { BrowserWindow } from 'electron';
import log from 'electron-log';
import {
  createHtmlArtifactPart,
  HTML_ARTIFACT_MAX_BODY_BYTES,
  HTML_ARTIFACT_MAX_TITLE_CODE_POINTS,
  utf8ByteLength,
  validateHtmlArtifactInput,
} from '../../../../shared/lib/artifacts/html-artifact';
import { createChatReplyArtifactId } from '../../../../shared/lib/flows/chat-reply-contract';
import { LAUNCH_FLAGS } from '../../../../shared/launch-flags';
import type { NodeOutput } from '../../../../shared/types/flow';
import { getDatabase } from '../../db';
import { resolveUpstreamStartTaskContext } from '../../db/repos/node-runs';
import {
  appendHtmlArtifactMessage,
  appendUserMessage,
  getSubChatById,
  getSubChatForChat,
} from '../../db/repos/sub-chats';
import { captureContained } from '../../sentry';
import { buildVariables } from '../block-context';
import { findUpstreamNodeIds, type ParsedFlowGraph } from '../graph';
import { renderTemplate, renderTemplateWithinUtf8Limit } from '../template-utils';
import type { Dispatcher } from './types';

function broadcastChatReply(payload: {
  chatId: string;
  subChatId: string;
  message: string;
  flowRunId: string;
  nodeRunId: string;
}): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send('socket:flow-chat-reply', payload);
    } catch {
      // window mid-close — skip
    }
  }
}

type ChatReplyConfig = {
  contentType?: 'text' | 'html_artifact';
  messageTemplate?: string;
  artifactTitleTemplate?: string;
  artifactBodyHtmlTemplate?: string;
};

type RenderedChatReply =
  | { ok: false; message: string }
  | {
      ok: true;
      contentType: 'text';
      displayText: string;
      part: { type: 'text'; text: string };
    }
  | {
      ok: true;
      contentType: 'html_artifact';
      displayText: string;
      artifactId: string;
      part: ReturnType<typeof createHtmlArtifactPart>;
    };

type ChatRefs = { chatId: string; subChatId: string };
type ChatRefSource = { chatId?: unknown; subChatId?: unknown };

function readStr(o: ChatRefSource | undefined, key: keyof ChatRefs): string | undefined {
  if (!o) return undefined;
  const v = o[key];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

async function resolveChatRefs(ctx: {
  flowRunId: string;
  nodeRunId: string;
  node: { id: string };
  parsedGraph: ParsedFlowGraph;
  triggerContext: Record<string, unknown> | null;
  previousOutput: { outputs?: Record<string, unknown> } | undefined;
}): Promise<ChatRefs | null> {
  const trigger = ctx.triggerContext ?? {};
  const prev = ctx.previousOutput?.outputs ?? {};

  // Fast path: post_task_trigger fan-out supplies both — no upstream query needed.
  const trigChat = readStr(trigger, 'chatId');
  const trigSub = readStr(trigger, 'subChatId');
  if (trigChat && trigSub) return { chatId: trigChat, subChatId: trigSub };

  // Otherwise resolve from the flow's upstream start_task (not the immediate
  // predecessor — a condition/agent in between drops chatId; sc-802). Precedence:
  // trigger → start_task → prev → newest-sub-chat fallback.
  const db = getDatabase();
  const up =
    (await resolveUpstreamStartTaskContext(db, ctx.flowRunId, {
      nodeRunId: ctx.nodeRunId,
      upstreamNodeIds: findUpstreamNodeIds(ctx.parsedGraph, ctx.node.id),
    })) ?? {};

  const chatId = trigChat ?? readStr(up, 'chatId') ?? readStr(prev, 'chatId') ?? null;
  if (!chatId) return null;

  const subChatId = trigSub ?? readStr(up, 'subChatId') ?? readStr(prev, 'subChatId') ?? null;
  if (subChatId) return { chatId, subChatId };

  // No subChatId in any source — fall back to the chat's sub-chat.
  const subChat = await getSubChatForChat(db, chatId);
  return subChat ? { chatId, subChatId: subChat.id } : null;
}

function renderChatReply(
  config: ChatReplyConfig,
  variables: ReturnType<typeof buildVariables>,
  flowRunId: string,
  nodeId: string,
  loopIndex: Parameters<typeof createChatReplyArtifactId>[2],
): RenderedChatReply {
  if (config.contentType !== 'html_artifact') {
    const template = config.messageTemplate?.trim();
    if (!template) return { ok: false, message: 'chat_reply missing messageTemplate' };
    const text = renderTemplate(template, variables);
    return { ok: true, contentType: 'text', displayText: text, part: { type: 'text', text } };
  }

  if (!LAUNCH_FLAGS.flowHtmlArtifacts) {
    return {
      ok: false,
      message:
        'This Chat Reply is set to an interactive view, which is turned off. Switch it to a text message.',
    };
  }

  const titleTemplate = config.artifactTitleTemplate?.trim();
  const bodyHtmlTemplate = config.artifactBodyHtmlTemplate?.trim();
  if (!titleTemplate) {
    return { ok: false, message: 'chat_reply missing artifactTitleTemplate' };
  }
  if (!bodyHtmlTemplate) {
    return { ok: false, message: 'chat_reply missing artifactBodyHtmlTemplate' };
  }
  if (utf8ByteLength(bodyHtmlTemplate) > HTML_ARTIFACT_MAX_BODY_BYTES) {
    return {
      ok: false,
      message: `chat_reply artifact body HTML exceeds ${HTML_ARTIFACT_MAX_BODY_BYTES.toLocaleString('en-US')} bytes`,
    };
  }

  const renderedTitle = renderTemplateWithinUtf8Limit(
    titleTemplate,
    variables,
    HTML_ARTIFACT_MAX_BODY_BYTES,
  );
  if (renderedTitle === undefined) {
    return {
      ok: false,
      message: `chat_reply artifact title exceeds ${HTML_ARTIFACT_MAX_TITLE_CODE_POINTS} characters`,
    };
  }
  const renderedBodyHtml = renderTemplateWithinUtf8Limit(
    bodyHtmlTemplate,
    variables,
    HTML_ARTIFACT_MAX_BODY_BYTES,
    bodyHtmlTemplate.length,
  );
  if (renderedBodyHtml === undefined) {
    return {
      ok: false,
      message: `chat_reply artifact body HTML exceeds ${HTML_ARTIFACT_MAX_BODY_BYTES.toLocaleString('en-US')} bytes`,
    };
  }
  const validated = validateHtmlArtifactInput(renderedTitle, renderedBodyHtml);
  if (!validated.ok) {
    const messages = {
      invalid_unicode: 'chat_reply artifact contains invalid Unicode',
      blank_title: 'chat_reply artifact title is blank after rendering',
      title_too_long: `chat_reply artifact title exceeds ${HTML_ARTIFACT_MAX_TITLE_CODE_POINTS} characters`,
      blank_body_html: 'chat_reply artifact body HTML is blank after rendering',
      body_html_too_large: `chat_reply artifact body HTML exceeds ${HTML_ARTIFACT_MAX_BODY_BYTES.toLocaleString('en-US')} bytes`,
    } as const;
    return { ok: false, message: messages[validated.reason] };
  }

  const artifactId = createChatReplyArtifactId(flowRunId, nodeId, loopIndex);
  return {
    ok: true,
    contentType: 'html_artifact',
    displayText: validated.title,
    artifactId,
    part: createHtmlArtifactPart({
      artifactId,
      title: validated.title,
      bodyHtml: validated.bodyHtml,
    }),
  };
}

export const dispatchChatReply: Dispatcher = async (ctx) => {
  const config = (ctx.node.config ?? {}) as ChatReplyConfig;
  const variables = buildVariables({
    triggerContext: ctx.triggerContext,
    previousOutput: ctx.previousOutput,
    loopContext: ctx.loopContext,
  });
  const rendered = renderChatReply(
    config,
    variables,
    ctx.flowRunId,
    ctx.node.id,
    ctx.loopContext?.currentIndex,
  );
  if (!rendered.ok) return { type: 'error', message: rendered.message };

  const refs = await resolveChatRefs(ctx);
  if (!refs) {
    return {
      type: 'error',
      message:
        'chat_reply requires chatId — set in triggerContext (post_task_trigger) or carried by an upstream start_task / agent node',
    };
  }

  const db = getDatabase();
  // A read failure CONTAINS as a node error rather than propagating: this runs inside the flow
  // engine, where a throw would terminalize nothing. The two outcomes are separate SHAPES rather
  // than null-vs-undefined, so "could not read" can never collapse into "does not exist" if the
  // repo's own empty value changes. See docs/decisions/sub-chat-read-failure-posture.md.
  const read = await getSubChatById(db, refs.subChatId).then(
    (subChat) => ({ ok: true as const, subChat }),
    (err: unknown) => {
      log.error('[chat_reply] sub-chat read failed', { subChatId: refs.subChatId, err });
      captureContained(err, { surface: 'flow-chat-reply', stage: 'sub-chat-read' });
      return { ok: false as const };
    },
  );
  if (!read.ok) {
    return { type: 'error', message: `chat_reply: could not read sub_chat ${refs.subChatId}` };
  }

  const subChat = read.subChat;
  if (!subChat || subChat.chatId !== refs.chatId) {
    return {
      type: 'error',
      message: `chat_reply: sub_chat ${refs.subChatId} not found in chat ${refs.chatId}`,
    };
  }

  const startedAt = Date.now();
  const message = {
    id: randomUUID(),
    role: 'assistant' as const,
    parts: [rendered.part],
    metadata: { source: 'chat_reply', flowRunId: ctx.flowRunId, nodeRunId: ctx.nodeRunId },
  };
  if (rendered.contentType === 'html_artifact') {
    const append = await appendHtmlArtifactMessage(
      db,
      refs.subChatId,
      message,
      rendered.artifactId,
    );
    if (append === 'missing') {
      return { type: 'error', message: `chat_reply: sub_chat ${refs.subChatId} not found` };
    }
  } else {
    await appendUserMessage(db, refs.subChatId, message);
  }

  // Renderer's useFlowChatReplySync listens for `socket:flow-chat-reply` to
  // invalidate tRPC cache. Without this broadcast the chat UI stays stale
  // until the user manually re-navigates.
  broadcastChatReply({
    chatId: refs.chatId,
    subChatId: refs.subChatId,
    message: rendered.displayText,
    flowRunId: ctx.flowRunId,
    nodeRunId: ctx.nodeRunId,
  });

  const outputs: NodeOutput['outputs'] = {
    chatId: refs.chatId,
    subChatId: refs.subChatId,
    message: rendered.displayText,
    contentType: rendered.contentType,
    delivered: true,
  };
  if (rendered.contentType === 'html_artifact') {
    outputs.artifactId = rendered.artifactId;
    outputs.title = rendered.displayText;
  }
  return {
    type: 'completed',
    output: {
      status: 'completed',
      outputs,
      artifacts: [],
      durationMs: Date.now() - startedAt,
    },
  };
};
