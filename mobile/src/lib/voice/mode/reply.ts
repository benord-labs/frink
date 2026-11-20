import type {
  MobileChatDetail,
  MobileMessage,
  MobileMessagePart,
} from '@frink/shared/types/remote/mobile';
import { spokenText } from './spoken-text';

/** Said when a reply had nothing to read aloud: only code, a table or file paths. */
export const CODE_ONLY = 'The reply is on screen.';
export const DONE = 'Done.';
/** A reply longer than this many sentences ends with a short "Done." so the listener knows. */
const LONG_REPLY = 3;

/** Read so far, per text part, keyed by message id and part index. */
type Read = { sentences: string[]; text: string; complete: boolean; hidden: boolean };
/** What one stretch of reply gave: sentences to say, and whether anything was left out. */
type Heard = { lines: string[]; hidden: boolean };
/** A turn, for the reader, is everything since the last idle snapshot. */
type Turn = { spoken: number; hidden: boolean };
export type ReplyReader = {
  read: ReadonlyMap<string, Read>;
  /** Whether the agent was working at the last snapshot. */
  running: boolean;
  turn: Turn;
};

type TextPart = { key: string; text: string; complete: boolean };

const NO_TURN: Turn = { spoken: 0, hidden: false };
/** A part never seen: all of it is new. */
const UNREAD: Read = { sentences: [], text: '', complete: false, hidden: false };

/** Every assistant text part in a snapshot. A part is complete once the agent stopped, or another
 *  part or reply follows it; a message of the user's after it may come while it still streams. */
function textParts(messages: MobileMessage[], running: boolean): TextPart[] {
  const lastReply = messages.reduce(
    (last, message, index) => (message.role === 'assistant' ? index : last),
    -1,
  );
  return messages.flatMap((message, index) => {
    if (message.role !== 'assistant') return [];
    const parts: MobileMessagePart[] = message.parts ?? [{ type: 'text', text: message.text }];
    const lastMessage = index === lastReply;
    return parts.flatMap((part, at) =>
      part.type === 'text'
        ? [
            {
              key: `${message.id}:${at}`,
              text: part.text,
              complete: !running || !lastMessage || at < parts.length - 1,
            },
          ]
        : [],
    );
  });
}

function readNow(part: TextPart): Read {
  const spoken = spokenText(part.text, part.complete);
  return {
    sentences: spoken.sentences,
    text: part.text,
    complete: part.complete,
    hidden: spoken.hidden,
  };
}

/** Starts reading after everything already in the chat, so only what comes next is spoken. */
export function startReading(messages: MobileMessage[], running: boolean): ReplyReader {
  const read = new Map<string, Read>();
  for (const part of textParts(messages, running)) read.set(part.key, readNow(part));
  return { read, running, turn: NO_TURN };
}

/** How many leading sentences two readings share. */
function sharedStart(read: string[], now: string[]): number {
  const differ = now.findIndex((sentence, index) => sentence !== read[index]);
  return Math.min(read.length, differ === -1 ? now.length : differ);
}

/** One part's sentences not read before, noting it in `read`. Sentences already read are never
 *  read again, however the part grows, shrinks or is rewritten in place. */
function readPart(read: Map<string, Read>, part: TextPart): Heard {
  const before = read.get(part.key) ?? UNREAD;
  if (before.text === part.text && before.complete === part.complete)
    return { lines: [], hidden: false };
  const spoken = spokenText(part.text, part.complete);
  const said = sharedStart(before.sentences, spoken.sentences);
  read.set(part.key, {
    sentences: spoken.sentences.length > said ? spoken.sentences : before.sentences,
    text: part.text,
    complete: part.complete,
    hidden: spoken.hidden || before.hidden,
  });
  return { lines: spoken.sentences.slice(said), hidden: spoken.hidden && !before.hidden };
}

/** A reader for one conversation and computer; `key` names them, so another starts afresh. */
export type Following = { key: string; reader: ReplyReader };
/** The conversation voice mode follows, on which computer. */
export type Watched = { deviceId: string | undefined; chatId: string; subChatId: string };

/** Follows a snapshot of the watched conversation, or gives null for a snapshot of another. A
 *  first snapshot, or one after the conversation changed, starts after everything in it. */
export function follow(current: Following | null, watched: Watched, data: MobileChatDetail) {
  if (data.chat.id !== watched.chatId || data.subChatId !== watched.subChatId) return null;
  const key = `${watched.deviceId}:${watched.chatId}:${watched.subChatId}`;
  const running = data.activity === 'running';
  if (current?.key !== key)
    return { following: { key, reader: startReading(data.messages, running) }, lines: [] };
  const next = readReply(current.reader, data.messages, running);
  return { following: { key, reader: next.reader }, lines: next.lines };
}

/** What the turn's end should say, given what was read aloud during it. */
function closingLine(turn: Turn): string | null {
  if (turn.spoken === 0) return turn.hidden ? CODE_ONLY : DONE;
  return turn.spoken > LONG_REPLY ? DONE : null;
}

/** The new sentences in a whole-chat snapshot, at any pace. An idle snapshot ends a turn that was
 *  running or arrived with it, and always starts the next turn's count afresh. */
export function readReply(reader: ReplyReader, messages: MobileMessage[], running: boolean) {
  const read = new Map(reader.read);
  const heard = textParts(messages, running).map((part) => readPart(read, part));
  const lines = heard.flatMap((part) => part.lines);
  const hidden = heard.some((part) => part.hidden);
  const turn = { spoken: reader.turn.spoken + lines.length, hidden: reader.turn.hidden || hidden };
  if (running) return { reader: { read, running, turn }, lines };
  const ended = reader.running || lines.length > 0 || hidden;
  const closing = ended ? closingLine(turn) : null;
  return { reader: { read, running, turn: NO_TURN }, lines: closing ? [...lines, closing] : lines };
}
