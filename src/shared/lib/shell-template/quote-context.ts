type ShellQuoteContext = 'single' | 'double';
export type ShellInterpolationContext = ShellQuoteContext | 'bare' | 'uncertain';
type ShellTemplateWarningContext = Exclude<ShellInterpolationContext, 'bare'>;

type ShellTemplateNode = {
  id: string;
  blockType: string;
  config?: Record<string, unknown>;
};

const TEMPLATE_PLACEHOLDER = /\{\{([^{}]+)\}\}/g;
const COMMENT_PREFIX_CHARACTER = /[\s;&|()<>]/;

function shellTemplateWarningMessage(
  placeholder: string,
  context: ShellTemplateWarningContext,
): string {
  if (context === 'uncertain') {
    return `Template variable ${placeholder} sits inside shell syntax Frink cannot confidently analyze (command substitution, backticks, a heredoc, or an unclosed quote), so it will NOT be substituted at runtime — the literal placeholder text reaches the shell. Move it to a bare position.`;
  }
  return `Template variable ${placeholder} is inside ${context} quotes. Frink context-escapes quoted values at runtime, but surrounding quotes are redundant and older versions could let untrusted trigger or webhook data become executable shell syntax. Leave the placeholder bare.`;
}

/**
 * Advisory design-time warnings for run_command placeholders in non-bare shell positions.
 * Classification uses the same `shellInterpolationContextAt` the runtime renderer uses, so a
 * warned `uncertain` placeholder is exactly one the runtime will leave literal.
 */
export function findQuotedShellTemplateWarnings(nodes: ShellTemplateNode[]): Array<{
  nodeId: string;
  field: string;
  placeholder: string;
  message: string;
  shellQuoteContext: ShellTemplateWarningContext;
}> {
  return nodes.flatMap((node) => {
    const command = node.blockType === 'run_command' ? node.config?.command : undefined;
    if (typeof command !== 'string') return [];
    const found = new Map<string, { placeholder: string; context: ShellTemplateWarningContext }>();
    for (const match of command.matchAll(TEMPLATE_PLACEHOLDER)) {
      const path = match[1]?.trim();
      if (!path) continue;
      const context = shellInterpolationContextAt(command, match.index, match[0].length);
      if (context === 'bare') continue;
      const placeholder = `{{${path}}}`;
      found.set(`${context}:${placeholder}`, { placeholder, context });
    }
    return [...found.values()].map(({ placeholder, context }) => ({
      nodeId: node.id,
      field: 'command',
      placeholder,
      shellQuoteContext: context,
      message: shellTemplateWarningMessage(placeholder, context),
    }));
  });
}

function isCommentStart(command: string, index: number, commentNewline = -1): boolean {
  const previous = previousIndex(command, index, commentNewline);
  if (previous < 0) return true;
  // An escaped separator such as `\;` is part of the word, so a `#` after it is too.
  if (!COMMENT_PREFIX_CHARACTER.test(command[previous])) return false;
  return previous === commentNewline || !isEscaped(command, previous);
}

/**
 * The index before `index` once backslash-newline continuations, which the shell deletes, are
 * skipped. The newline that ends a comment is never a continuation, so the walk stops there.
 */
function previousIndex(text: string, index: number, commentNewline = -1): number {
  let previous = index - 1;
  while (
    previous >= 1 &&
    previous !== commentNewline &&
    text[previous] === '\n' &&
    isEscaped(text, previous)
  ) {
    previous -= 2;
  }
  return previous;
}

/** Whether an odd run of backslashes ends right before `index`. */
function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  while (text[index - 1 - backslashes] === '\\') backslashes++;
  return backslashes % 2 === 1;
}

/** Index just past the `)` closing the `$(` body at `start`, or null: unclosed, or holding a
 *  backtick or `$'` string, which this scan cannot pair exactly. */
function findCommandSubstitutionEnd(command: string, start: number): number | null {
  const scanner = new QuoteScanner(command, start, 1);
  while (scanner.position < command.length) {
    const at = scanner.position;
    const char = scanner.readCode();
    if (char === '`' || (char === '$' && command[at + 1] === "'")) return null;
    if (char === ')' && scanner.openParens === 0) return at + 1;
  }
  return null;
}

/** Index just past the backtick closing the substitution opened at `start`, or null. */
function findBacktickEnd(command: string, start: number): number | null {
  for (let i = start + 1; i < command.length; i += command[i] === '\\' ? 2 : 1) {
    if (command[i] === '`') return i + 1;
  }
  return null;
}

/** Index just past the quote closing the `$'…'` string opened at `start`, or null. */
function findAnsiCStringEnd(command: string, start: number): number | null {
  for (let i = start + 2; i < command.length; i += command[i] === '\\' ? 2 : 1) {
    // bash reads \' as part of the string but dash ends the string there, so fail closed.
    if (command[i] === '\\' && command[i + 1] === "'") return null;
    if (command[i] === "'") return i + 1;
  }
  return null;
}

/** Whether a construct starting at `start` is live: not escaped, single-quoted or commented out. */
function isLive(scanner: QuoteScanner, start: number): boolean {
  const state = scanner.stateAt(start);
  return scanner.position === start && state !== 'single' && state !== 'comment';
}

/**
 * Masks every closed `$'…'`, backtick and `$( … )` construct in one left-to-right pass, so whichever
 * opens first owns the text it spans. An unclosed one cuts the text there.
 */
function maskConstructs(command: string): string {
  const scanner = new QuoteScanner(command);
  const tokens = ["$'", '`', '$('];
  const nextAt = tokens.map(() => -2);
  let searchFrom = 0;
  for (;;) {
    for (const [i, token] of tokens.entries()) {
      if (nextAt[i] !== -1 && nextAt[i] < searchFrom)
        nextAt[i] = command.indexOf(token, searchFrom);
    }
    const found = nextAt.filter((at) => at !== -1);
    if (found.length === 0) return scanner.masked();
    const start = Math.min(...found);
    const isAnsiC = command.startsWith("$'", start);
    // An ANSI-C string inside double quotes is plain text; backticks and $( ) still substitute.
    const live = isLive(scanner, start) && (!isAnsiC || scanner.stateAt(start) === null);
    if (!live) {
      searchFrom = start + 1;
      continue;
    }
    let end: number | null;
    if (isAnsiC) end = findAnsiCStringEnd(command, start);
    else if (command[start] === '`') end = findBacktickEnd(command, start);
    else end = findCommandSubstitutionEnd(command, start + 2);
    if (end === null) return scanner.masked().slice(0, start);
    scanner.blank(start, end);
    searchFrom = end;
  }
}

/** The command with opaque segments masked, cut at the first construct the classifier cannot follow. */
function maskOpaqueShellSegments(command: string): string {
  const masked = maskConstructs(command);
  // A continuation inside `$(`, `$'` or `<<` hides the construct from the pass above.
  const cuts = [firstUnquoted(masked, '<<'), firstUnquoted(masked, '<\\\n')];
  cuts.push(firstLive(masked, '$\\\n'));
  const cut = Math.min(...cuts.filter((at) => at !== -1));
  return Number.isFinite(cut) ? masked.slice(0, cut) : masked;
}

/** The first occurrence of `token` that is not escaped, single-quoted or commented out, or -1. */
function firstLive(text: string, token: string): number {
  const scanner = new QuoteScanner(text);
  for (let at = text.indexOf(token); at !== -1; at = text.indexOf(token, at + 1)) {
    if (isLive(scanner, at)) return at;
  }
  return -1;
}

/** The first occurrence of `token` outside quotes and comments, or -1. */
function firstUnquoted(text: string, token: string): number {
  const scanner = new QuoteScanner(text);
  for (let at = text.indexOf(token); at !== -1; at = text.indexOf(token, at + 1)) {
    if (scanner.stateAt(at) === null) return at;
  }
  return -1;
}

const STATES = [null, 'single', 'double', 'comment', 'escaped'] as const;

/** What classifying any placeholder of one command needs; arrays cover `analyzable`, not the command. */
type CommandAnalysis = {
  command: string;
  analyzable: string;
  /** Index into STATES of the scan state at each offset of `analyzable`; 'escaped' follows a `\\`. */
  stateAt: Uint8Array;
  lastSingleQuote: number;
  /** 1 when an unescaped `"` occurs at or after the offset, scanning escapes from that offset. */
  doubleQuoteFrom: Uint8Array;
};

/** Callers classify every placeholder of one command in turn, so one analysis serves them all. */
let lastAnalysis: CommandAnalysis | undefined;

/** Analyses a command once, in time linear in its length. */
function analyzeCommand(command: string): CommandAnalysis {
  if (lastAnalysis?.command === command) return lastAnalysis;
  const analyzable = maskOpaqueShellSegments(command);
  const scanner = new QuoteScanner(analyzable);
  const stateAt = new Uint8Array(analyzable.length + 1);
  for (let offset = 0; offset <= analyzable.length; offset++) {
    const state = scanner.stateAt(offset);
    // The scan jumps past a character a backslash escapes, so it lands beyond `offset`.
    stateAt[offset] = STATES.indexOf(scanner.position > offset ? 'escaped' : state);
  }
  const doubleQuoteFrom = new Uint8Array(analyzable.length + 2);
  for (let i = analyzable.length - 1; i >= 0; i--) {
    if (analyzable[i] === '\\') doubleQuoteFrom[i] = doubleQuoteFrom[i + 2];
    else doubleQuoteFrom[i] = analyzable[i] === '"' ? 1 : doubleQuoteFrom[i + 1];
  }
  const lastSingleQuote = analyzable.lastIndexOf("'");
  lastAnalysis = { command, analyzable, stateAt, lastSingleQuote, doubleQuoteFrom };
  return lastAnalysis;
}

/**
 * Classifies one template placeholder's shell quote context.
 *
 * Closed command substitutions, backticks, and ANSI-C strings before the placeholder are treated
 * as opaque. A placeholder inside one of those constructs, after a heredoc, in a comment, or in an
 * unclosed quote is uncertain and must not be expanded into the executable shell string.
 */
export function shellInterpolationContextAt(
  command: string,
  offset: number,
  matchLength: number,
): ShellInterpolationContext {
  const { analyzable, stateAt, lastSingleQuote, doubleQuoteFrom } = analyzeCommand(command);
  const end = offset + matchLength;
  if (analyzable.length < command.length && end > analyzable.length) return 'uncertain';
  if (analyzable.slice(offset, end) !== command.slice(offset, end)) return 'uncertain';
  const state = STATES[stateAt[offset]];
  if (state === 'comment' || state === 'escaped') return 'uncertain';
  // After `$` the bare wrapper would open `$'…'`, where an escaped quote ends the string early.
  if (state !== 'single' && analyzable[previousIndex(analyzable, offset)] === '$')
    return 'uncertain';
  if (state === 'single' && lastSingleQuote < end) return 'uncertain';
  if (state === 'double' && doubleQuoteFrom[end] === 0) return 'uncertain';
  return state ?? 'bare';
}

/** Shell-escapes a resolved template value for its already-classified interpolation position. */
export function escapeShellValueForContext(
  value: string,
  context: ShellInterpolationContext,
): string | null {
  const clean = value.replace(/\0/g, '');
  if (context === 'uncertain') return null;
  if (context === 'single') return clean.replace(/'/g, "'\\''");
  if (context === 'double') return clean.replace(/[\\$"\x60]/g, '\\$&');
  return `'${clean.replace(/'/g, "'\\''")}'`;
}

function toggleQuote(quote: ShellQuoteContext | null, char: string): ShellQuoteContext | null {
  if (char === "'" && quote !== 'double') return quote === 'single' ? null : 'single';
  if (char === '"' && quote !== 'single') return quote === 'double' ? null : 'double';
  return quote;
}

/** Shell quote and comment state, read left to right; the ends asked for must never decrease. */
class QuoteScanner {
  private index: number;
  private quote: ShellQuoteContext | null = null;
  private inComment = false;
  private wordPartEnd = -1;
  private kept = 0;
  private readonly chunks: string[] = [];
  /** One entry per open `(`: true when it opened a `$( … )` substitution, which is a word part. */
  private readonly parens: boolean[];
  private dollarAt = -1;
  private commentNewline = -1;

  constructor(
    private readonly text: string,
    start = 0,
    openSubstitutions = 0,
  ) {
    this.index = start;
    this.parens = Array.from({ length: openSubstitutions }, () => true);
  }

  get position(): number {
    return this.index;
  }

  get openParens(): number {
    return this.parens.length;
  }

  /** The scan state before `end`: a quote, 'comment', or null when unquoted. */
  stateAt(end: number): ShellQuoteContext | 'comment' | null {
    while (this.index < end) this.readCode();
    return this.inComment ? 'comment' : this.quote;
  }

  /** Masks [start, end) as one word part, which never changes quote or comment state, and skips it. */
  blank(start: number, end: number): void {
    this.chunks.push(this.text.slice(this.kept, start), '_'.repeat(end - start));
    this.kept = end;
    this.index = end;
    this.wordPartEnd = end;
  }

  /** The text with every masked range replaced by word characters. */
  masked(): string {
    return this.chunks.join('') + this.text.slice(this.kept);
  }

  /** Reads one character, returning it when the shell reads it as unquoted, uncommented code. */
  readCode(): string | undefined {
    const i = this.index++;
    const char = this.text[i];
    if (this.inComment) {
      if (char === '\n') {
        this.inComment = false;
        this.commentNewline = i;
      }
      return undefined;
    }
    if (
      this.quote === null &&
      char === '#' &&
      previousIndex(this.text, i, this.commentNewline) !== this.wordPartEnd - 1 &&
      isCommentStart(this.text, i, this.commentNewline)
    ) {
      this.inComment = true;
      return undefined;
    }
    if (this.quote !== 'single' && char === '\\') {
      this.index++;
      return undefined;
    }
    const before = this.quote;
    this.quote = toggleQuote(before, char);
    if (before !== null || this.quote !== null) return undefined;
    if (char === '(') {
      const previous = previousIndex(this.text, i, this.commentNewline);
      this.parens.push(previous >= 0 && this.dollarAt === previous);
    }
    // A `#` right after a `$( … )` continues the word; after a `( … )` group it starts a comment.
    if (char === ')' && this.parens.pop()) this.wordPartEnd = i + 1;
    this.dollarAt = char === '$' ? i : -1;
    return char;
  }
}
