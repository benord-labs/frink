import { parseMention } from '../../../shared/lib/mentions/parse-mention';

/** The element a valid `@[id]` mention token becomes in rendered markdown. */
export const MENTION_ELEMENT = 'frink-mention';

const MENTION_TOKEN = 'frinkMention';
const AT_SIGN = 64;
const OPEN_BRACKET = 91;
const CLOSE_BRACKET = 93;
const WHITESPACE = /\s/;

// Structural slices of the micromark and mdast-util-from-markdown APIs used below.
type Code = number | null;
type State = (code: Code) => State | undefined;
type Effects = {
  consume(code: Code): void;
  enter(type: string): void;
  exit(type: string): void;
  attempt(construct: Construct, ok: State, nok: State): State;
};
type Construct = { tokenize(effects: Effects, ok: State, nok: State): State };
type Token = { type: string };
type MentionNode = {
  type: string;
  value: string;
  data: { hName: string; hProperties: { dataMentionId: string }; hChildren: object[] };
};
type FromMarkdownContext = {
  sliceSerialize(token: Token): string;
  enter(node: MentionNode, token: Token): void;
  exit(token: Token): void;
};
type MentionProcessor = { data(): object };
type ParserExtensions = { micromarkExtensions?: object[]; fromMarkdownExtensions?: object[] };

/** Reads `@[id]` to the bracket that closes it and accepts it when `id` parses as a mention.
 * With `paired`, the id has no whitespace and its brackets pair up, as in `app/[id]`. */
function mentionTokenizer(paired: boolean): Construct['tokenize'] {
  return (effects, ok, nok) => {
    let id = '';
    let depth = 0;
    const inside: State = (code) => {
      if (code === null || code < 0) return nok(code);
      if (paired && WHITESPACE.test(String.fromCodePoint(code))) return nok(code);
      if (code === CLOSE_BRACKET && depth === 0) {
        if (!parseMention(id)) return nok(code);
        effects.consume(code);
        effects.exit(MENTION_TOKEN);
        return ok;
      }
      if (paired && code === OPEN_BRACKET) depth += 1;
      if (paired && code === CLOSE_BRACKET) depth -= 1;
      id += String.fromCodePoint(code);
      effects.consume(code);
      return inside;
    };
    const open: State = (code) => {
      if (code !== OPEN_BRACKET) return nok(code);
      effects.consume(code);
      return inside;
    };
    return (code) => {
      effects.enter(MENTION_TOKEN);
      effects.consume(code);
      return open;
    };
  };
}

const PAIRED_MENTION: Construct = { tokenize: mentionTokenizer(true) };
const FIRST_CLOSE_MENTION: Construct = { tokenize: mentionTokenizer(false) };

/** Matches the shared token pattern: an id with paired brackets, else one ending at the first `]`. */
function tokenizeMention(effects: Effects, ok: State, nok: State): State {
  return effects.attempt(PAIRED_MENTION, ok, effects.attempt(FIRST_CLOSE_MENTION, ok, nok));
}

// The raw token is the element's only child, so a renderer without a chip still shows it,
// and the node's value, so plain-text uses such as image alt text keep it.
function enterMention(this: FromMarkdownContext, token: Token): void {
  const raw = this.sliceSerialize(token);
  const data = {
    hName: MENTION_ELEMENT,
    hProperties: { dataMentionId: raw.slice(2, -1) },
    hChildren: [{ type: 'text', value: raw }],
  };
  this.enter({ type: MENTION_TOKEN, value: raw, data }, token);
}

function exitMention(this: FromMarkdownContext, token: Token): void {
  this.exit(token);
}

// Parses `@[id]` mention tokens before inline markdown, so a path such as
// `src/__tests__/a*b.ts` is never read as emphasis, strikethrough or a link.
function remarkMentions(this: MentionProcessor): void {
  const data: ParserExtensions = this.data();
  (data.micromarkExtensions ??= []).push({
    text: { [AT_SIGN]: { name: MENTION_TOKEN, tokenize: tokenizeMention } },
  });
  (data.fromMarkdownExtensions ??= []).push({
    enter: { [MENTION_TOKEN]: enterMention },
    exit: { [MENTION_TOKEN]: exitMention },
  });
}

/** Remark plugins for mention tokens; unified calls each with its processor as `this`. */
export const MENTION_REMARK_PLUGINS = [remarkMentions];
