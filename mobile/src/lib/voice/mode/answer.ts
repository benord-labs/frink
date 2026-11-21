import type {
  MobileChatDetail,
  MobilePermission,
  MobileQuestion,
  MobileRequest,
} from '@frink/shared/types/remote/mobile';
import { spokenText } from './spoken-text';

/** What a spoken answer may settle: a permission, or a question with one list of choices. */
export type Ask =
  | { kind: 'permission'; id: string }
  | { kind: 'question'; id: string; question: string; options: string[] };
/** The open decision as voice mode tells it; `ask` is null when it must be answered on screen.
 *  `id` names the kind too, so a permission and a question can never be mistaken for each other. */
export type Decision = { id: string; line: string; ask: Ask | null };
export type Answer =
  | { kind: 'permission'; id: string; approved: boolean }
  | { kind: 'question'; id: string; question: string; label: string };

export const ON_SCREEN = 'Please answer on screen.';
const APPROVE = new Set(['yes', 'allow', 'approve', 'allow it', 'allow once']);
const DENY = new Set(['no', 'deny', 'deny it', 'dont allow', 'do not allow']);
const NUMBERS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
/** Spoken details stop here; the rest stays on screen. */
const DETAIL_CAP = 100;
/** A longer tool name is left to the screen. */
const MAX_TOOL_WORDS = 5;
/** The title of a request to move the chat to another project. */
const MOVE_CHAT = 'Move chat';

/** Lower case, apostrophes dropped, every other mark a space, spaces collapsed. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The words a choice can be named by: its number, as a digit or a word, or its label. */
function optionNames(index: number, label: string): string[] {
  const numbers = [String(index + 1), NUMBERS[index]];
  return [normalize(label), ...numbers, ...numbers.map((number) => `option ${number}`)];
}

/**
 * The answer a final transcript gives, or null. The whole utterance must be exactly one of the
 * fixed phrases (or an option's number or label), so a misheard or hedged reply settles nothing.
 */
export function decideAnswer(ask: Ask, transcript: string, final: boolean): Answer | null {
  const said = normalize(transcript);
  if (!final || !said) return null;
  if (ask.kind === 'permission') {
    if (APPROVE.has(said)) return { kind: 'permission', id: ask.id, approved: true };
    if (DENY.has(said)) return { kind: 'permission', id: ask.id, approved: false };
    return null;
  }
  const matches = ask.options.filter((label, index) => optionNames(index, label).includes(said));
  return matches.length === 1
    ? { kind: 'question', id: ask.id, question: ask.question, label: matches[0] }
    : null;
}

/** At most a short sentence of `text`, cut at a word, saying where the rest is. */
function capped(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= DETAIL_CAP) return flat;
  const cut = flat.lastIndexOf(' ', DETAIL_CAP);
  return `${flat.slice(0, cut > 0 ? cut : DETAIL_CAP)}… The rest is on screen.`;
}

/** The words of an add-on tool's own name, as the card's title shows it, e.g. "create issue". */
function toolWords(title: string): string | null {
  const name = /^mcp__.+__([A-Za-z0-9_-]+)$/.exec(title)?.[1] ?? '';
  const words = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean);
  return words.length && words.length <= MAX_TOOL_WORDS ? words.join(' ').toLowerCase() : null;
}

/** What the request is for, from its title alone, or nothing when the title can't say. */
function requestKind(title: string): string {
  if (title === MOVE_CHAT) return ' to move this chat';
  const tool = toolWords(title);
  return tool ? ` to use the ${tool} tool` : '';
}

/** The kind of request in plain words. Its description, which may hold a command, a path or a
 *  file's contents, is never read out. */
function permissionLine(permission: MobilePermission): string {
  const answer = permission.supported ? 'Say allow or deny.' : 'Answer it on your computer.';
  return `Frink is asking permission${requestKind(permission.title)}. The details are on screen. ${answer}`;
}

/** `text` as prose to read aloud, or null when code, a table or a path in it must stay on screen. */
function speakable(text: string): string | null {
  const spoken = spokenText(text, true);
  return spoken.hidden || !spoken.sentences.length ? null : capped(spoken.sentences.join(' '));
}

/** A single-choice question is read out when its words and every choice can be read as prose. */
function questionDecision(prompt: MobileQuestion): Decision {
  const id = `question:${prompt.id}`;
  const [only] = prompt.questions;
  const single = prompt.questions.length === 1 && !only.multiSelect;
  const choices = single ? only.options.map((option) => option.label) : [];
  const question = single ? speakable(only.question) : null;
  const spoken = choices.map(speakable).filter((label): label is string => label !== null);
  const fits = choices.length > 0 && choices.length <= NUMBERS.length;
  if (!question || !fits || spoken.length !== choices.length)
    return { id, line: 'Frink has a question for you. It’s on screen.', ask: null };
  const options = spoken.map((label, index) => `${index + 1}: ${label}.`).join(' ');
  return {
    id,
    line: `Frink asks: ${question} ${options} Say a number.`,
    ask: { kind: 'question', id: prompt.id, question: only.question, options: choices },
  };
}

/** The first open permission or question, as voice mode reads it out. */
export function openDecision(data: MobileChatDetail): Decision | null {
  const [permission] = data.permissions;
  if (permission)
    return {
      id: `permission:${permission.requestId}`,
      line: permissionLine(permission),
      ask: permission.supported ? { kind: 'permission', id: permission.requestId } : null,
    };
  const [question] = data.questions;
  return question ? questionDecision(question) : null;
}

/** One request id per decision, so the computer knows an answer given again as the same one. */
export function sameRequestId(ids: Map<string, string>, id: string, fresh: () => string): string {
  const requestId = ids.get(id) ?? fresh();
  ids.set(id, requestId);
  return requestId;
}

/**
 * The request that sends a spoken answer, checked against the chat as it is now: only a request
 * that is still open (and, for a permission, one the phone may answer) gets one.
 */
export function answerRequest(
  answer: Answer,
  data: MobileChatDetail,
  requestId: string,
): MobileRequest | null {
  if (answer.kind === 'permission') {
    const permission = data.permissions.find((item) => item.requestId === answer.id);
    if (!permission?.supported) return null;
    const { chatId, subChatId } = permission;
    return {
      type: 'respondPermission',
      requestId: answer.id,
      chatId,
      subChatId,
      approved: answer.approved,
    };
  }
  const question = data.questions.find((item) => item.id === answer.id);
  if (!question) return null;
  const { id, source, chatId, subChatId } = question;
  const answers = { [answer.question]: answer.label };
  return { type: 'answerQuestion', id, source, chatId, subChatId, answers, requestId };
}
