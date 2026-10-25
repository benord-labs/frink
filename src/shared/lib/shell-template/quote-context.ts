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

function isCommentStart(command: string, index: number): boolean {
  return index === 0 || COMMENT_PREFIX_CHARACTER.test(command[index - 1] ?? '');
}

function findCommandSubstitutionEnd(command: string, start: number): number | null {
  let depth = 1;
  let quote: ShellQuoteContext | null = null;
  for (let i = start; i < command.length; i++) {
    const char = command[i];
    if (quote !== 'single' && char === '\\') {
      i++;
      continue;
    }
    quote = toggleQuote(quote, char);
    if (quote !== null) continue;
    if (char === '(') depth++;
    if (char === ')' && --depth === 0) return i + 1;
  }
  return null;
}

/** Blanks every closed `$( … )` outside single quotes, in one left-to-right pass. */
function maskCommandSubstitutions(command: string): string {
  const scanner = new QuoteScanner(command);
  let searchFrom = 0;
  while (searchFrom < command.length) {
    const start = command.indexOf('$(', searchFrom);
    if (start === -1) break;
    if (scanner.contextAt(start) === 'single') {
      searchFrom = start + 2;
      continue;
    }
    const end = findCommandSubstitutionEnd(command, start + 2);
    if (end === null) {
      searchFrom = start + 2;
      continue;
    }
    scanner.blank(start, end);
    searchFrom = end;
  }
  return scanner.masked();
}

/** Blanks every closed backtick substitution outside single quotes, in one left-to-right pass. */
function maskBacktickSubstitutions(command: string): string {
  const scanner = new QuoteScanner(command);
  let searchFrom = 0;
  while (searchFrom < command.length) {
    const start = command.indexOf('`', searchFrom);
    if (start === -1) break;
    if (scanner.contextAt(start) === 'single') {
      searchFrom = start + 1;
      continue;
    }
    const end = command.indexOf('`', start + 1);
    if (end === -1) break;
    scanner.blank(start, end + 1);
    searchFrom = end + 1;
  }
  return scanner.masked();
}

/** Blanks every closed `$'…'` ANSI-C string outside quotes and comments, in one left-to-right pass. */
function maskAnsiCStrings(command: string): string {
  const scanner = new QuoteScanner(command);
  let searchFrom = 0;
  while (searchFrom < command.length) {
    const start = command.indexOf("$'", searchFrom);
    if (start === -1) break;
    if (scanner.contextAt(start) !== null) {
      searchFrom = start + 2;
      continue;
    }
    let end = start + 2;
    while (end < command.length && command[end] !== "'") {
      if (command[end] === '\\') end++;
      end++;
    }
    if (end >= command.length) break;
    scanner.blank(start, end + 1);
    searchFrom = end + 1;
  }
  return scanner.masked();
}

/** The command with opaque segments blanked, cut at the first construct the classifier cannot follow. */
function maskOpaqueShellSegments(command: string): string {
  const withoutAnsiStrings = maskAnsiCStrings(command);
  const withoutBackticks = maskBacktickSubstitutions(withoutAnsiStrings);
  const masked = maskCommandSubstitutions(withoutBackticks);
  const uncertainOffsets = [masked.indexOf('$('), masked.indexOf('`')].filter(
    (offset) => offset >= 0 && quoteContextAt(masked, offset) !== 'single',
  );
  const heredocOffset = masked.indexOf('<<');
  if (heredocOffset >= 0 && quoteContextAt(masked, heredocOffset) === null) {
    uncertainOffsets.push(heredocOffset);
  }
  return uncertainOffsets.length === 0 ? masked : masked.slice(0, Math.min(...uncertainOffsets));
}

const QUOTES = [null, 'single', 'double'] as const;

/** What classifying any placeholder of one command needs; arrays cover `analyzable`, not the command. */
type CommandAnalysis = {
  command: string;
  analyzable: string;
  /** Index into QUOTES of the quote context at each offset of `analyzable`. */
  quoteAt: Uint8Array;
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
  const quoteAt = new Uint8Array(analyzable.length + 1);
  for (let offset = 0; offset <= analyzable.length; offset++) {
    quoteAt[offset] = QUOTES.indexOf(scanner.contextAt(offset));
  }
  const doubleQuoteFrom = new Uint8Array(analyzable.length + 2);
  for (let i = analyzable.length - 1; i >= 0; i--) {
    if (analyzable[i] === '\\') doubleQuoteFrom[i] = doubleQuoteFrom[i + 2];
    else doubleQuoteFrom[i] = analyzable[i] === '"' ? 1 : doubleQuoteFrom[i + 1];
  }
  const lastSingleQuote = analyzable.lastIndexOf("'");
  lastAnalysis = { command, analyzable, quoteAt, lastSingleQuote, doubleQuoteFrom };
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
  const { analyzable, quoteAt, lastSingleQuote, doubleQuoteFrom } = analyzeCommand(command);
  const end = offset + matchLength;
  if (analyzable.length < command.length && end > analyzable.length) return 'uncertain';
  if (analyzable.slice(offset, end) !== command.slice(offset, end)) return 'uncertain';
  const quote = QUOTES[quoteAt[offset]];
  if (quote === 'single' && lastSingleQuote < end) return 'uncertain';
  if (quote === 'double' && doubleQuoteFrom[end] === 0) return 'uncertain';
  return quote ?? 'bare';
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

/** The quote context before `end`, as a shell reading `command` from its start would see it. */
function quoteContextAt(command: string, end: number): ShellQuoteContext | null {
  return new QuoteScanner(command).contextAt(end);
}

/** Shell quote and comment state, read left to right; `contextAt` ends must never decrease. */
class QuoteScanner {
  private index = 0;
  private quote: ShellQuoteContext | null = null;
  private inComment = false;
  private blankEnd = -1;
  private kept = 0;
  private readonly chunks: string[] = [];

  constructor(private readonly text: string) {}

  /** The quote context before `end`: null when unquoted or inside a comment. */
  contextAt(end: number): ShellQuoteContext | null {
    while (this.index < end) this.step();
    return this.inComment ? null : this.quote;
  }

  /** Replaces [start, end) with spaces, which never change quote or comment state, and skips it. */
  blank(start: number, end: number): void {
    this.chunks.push(this.text.slice(this.kept, start), ' '.repeat(end - start));
    this.kept = end;
    this.index = end;
    this.blankEnd = end;
  }

  /** The text with every blanked range replaced by spaces. */
  masked(): string {
    return this.chunks.join('') + this.text.slice(this.kept);
  }

  private step(): void {
    const i = this.index++;
    const char = this.text[i];
    if (this.inComment) {
      this.inComment = char !== '\n';
      return;
    }
    // Right after a blanked range the previous character is a space, which starts a comment.
    if (
      this.quote === null &&
      char === '#' &&
      (i === this.blankEnd || isCommentStart(this.text, i))
    ) {
      this.inComment = true;
      return;
    }
    if (this.quote !== 'single' && char === '\\') {
      this.index++;
      return;
    }
    this.quote = toggleQuote(this.quote, char);
  }
}
