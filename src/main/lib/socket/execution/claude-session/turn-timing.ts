import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import log from 'electron-log';
import type { ClaudeSession } from '../../claude-session-registry';

/** The stamps behind the per-turn `turn-timing` log line; a turn's frames count only once pushed. */
export type TurnTiming = {
  path: 'fresh' | 'warm' | 'adopted';
  pushedAt?: number;
  initAt?: number;
  firstTokenAt?: number;
};

/** Stamp the turn's first `system/init` and first model token (content delta, or a whole assistant
 * message when partials are off). */
export function noteTurnTiming(turn: TurnTiming, msg: SDKMessage): void {
  if (turn.pushedAt === undefined) return;
  if (msg.type === 'system' && msg.subtype === 'init') turn.initAt ??= Date.now();
  const isDelta = msg.type === 'stream_event' && msg.event.type === 'content_block_delta';
  if (isDelta || msg.type === 'assistant') turn.firstTokenAt ??= Date.now();
}

/** One line per pushed turn: cold start (spawn → init) against prompt latency (push → first token). */
export function logTurnTiming(session: ClaudeSession, turn: TurnTiming): void {
  const { pushedAt, initAt, firstTokenAt, path } = turn;
  if (pushedAt === undefined) return;
  const ms = (from: number, to: number | undefined) => (to === undefined ? 'na' : to - from);
  log.info(
    `[Claude Session] turn-timing sub=${session.subChatId} path=${path} spawnToInitMs=${ms(session.loop.spawnedAt, initAt)} pushToInitMs=${ms(pushedAt, initAt)} pushToFirstTokenMs=${ms(pushedAt, firstTokenAt)} initFrame=${initAt === undefined ? 'no' : 'yes'}`,
  );
}
