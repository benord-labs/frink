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

function maskCommandSubstitutions(command: string): string {
  let masked = command;
  let searchFrom = 0;
  while (searchFrom < masked.length) {
    const start = masked.indexOf('$(', searchFrom);
    if (start === -1) break;
    const context = quoteContextAt(masked, start);
    if (context === 'single') {
      searchFrom = start + 2;
      continue;
    }
    const end = findCommandSubstitutionEnd(masked, start + 2);
    if (end === null) {
      searchFrom = start + 2;
      continue;
    }
    masked = `${masked.slice(0, start)}${' '.repeat(end - start)}${masked.slice(end)}`;
    searchFrom = end;
  }
  return masked;
}

function maskBacktickSubstitutions(command: string): string {
  let masked = command;
  let searchFrom = 0;
  while (searchFrom < masked.length) {
    const start = masked.indexOf('`', searchFrom);
    if (start === -1) break;
    if (quoteContextAt(masked, start) === 'single') {
      searchFrom = start + 1;
      continue;
    }
    const end = masked.indexOf('`', start + 1);
    if (end === -1) break;
    masked = `${masked.slice(0, start)}${' '.repeat(end + 1 - start)}${masked.slice(end + 1)}`;
    searchFrom = end + 1;
  }
  return masked;
}

function maskAnsiCStrings(command: string): string {
  let masked = command;
  let searchFrom = 0;
  while (searchFrom < masked.length) {
    const start = masked.indexOf("$'", searchFrom);
    if (start === -1) break;
    if (quoteContextAt(masked, start) !== null) {
      searchFrom = start + 2;
      continue;
    }
    let end = start + 2;
    while (end < masked.length && masked[end] !== "'") {
      if (masked[end] === '\\') end++;
      end++;
    }
    if (end >= masked.length) break;
    masked = `${masked.slice(0, start)}${' '.repeat(end + 1 - start)}${masked.slice(end + 1)}`;
    searchFrom = end + 1;
  }
  return masked;
}

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
  const analyzableCommand = maskOpaqueShellSegments(command);
  if (
    analyzableCommand.length < command.length &&
    offset + matchLength > analyzableCommand.length
  ) {
    return 'uncertain';
  }
  if (
    analyzableCommand.slice(offset, offset + matchLength) !==
    command.slice(offset, offset + matchLength)
  ) {
    return 'uncertain';
  }
  const quote = quoteContextAt(analyzableCommand, offset);
  if (quote && !hasClosingQuote(analyzableCommand, offset + matchLength, quote)) {
    return 'uncertain';
  }
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

function quoteContextAt(command: string, end: number): ShellQuoteContext | null {
  let quote: ShellQuoteContext | null = null;
  let inComment = false;
  for (let i = 0; i < end; i++) {
    const char = command[i];
    if (inComment) {
      inComment = char !== '\n';
      continue;
    }
    if (quote === null && char === '#' && isCommentStart(command, i)) {
      inComment = true;
      continue;
    }
    if (quote !== 'single' && char === '\\') {
      i++;
      continue;
    }
    quote = toggleQuote(quote, char);
  }
  return inComment ? null : quote;
}

function hasClosingQuote(command: string, start: number, quote: ShellQuoteContext): boolean {
  for (let i = start; i < command.length; i++) {
    if (quote === 'double' && command[i] === '\\') {
      i++;
      continue;
    }
    if (command[i] === (quote === 'single' ? "'" : '"')) return true;
  }
  return false;
}
