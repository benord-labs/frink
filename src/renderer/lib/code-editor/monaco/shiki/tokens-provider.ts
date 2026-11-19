import type { languages } from 'monaco-editor';
import type { Highlighter } from 'shiki';
import { colourToken, normalizeColor } from '../shiki-theme-to-monaco';

type Grammar = ReturnType<Highlighter['getLanguage']>;
type StateStack = Parameters<Grammar['tokenizeLine2']>[1];

const MAX_LINE_LENGTH = 20_000;
const TIME_LIMIT_MS = 500;

// TextMate's encoded token metadata (vscode-textmate's EncodedTokenMetadata).
const TOKEN_TYPE_MASK = 0b11 << 8;
const FONT_STYLE_MASK = 0b1111 << 11;
const FOREGROUND_MASK = 0b111111111 << 15;
const STYLE_MASK = TOKEN_TYPE_MASK | FONT_STYLE_MASK | FOREGROUND_MASK;
// Monaco reads comment/string/regex from the token name; auto-closing and brackets depend on it.
const TOKEN_TYPES = ['', '.comment', '.string', '.regex'];

// The committed code theme; unset until its Shiki theme has loaded.
let editorSyntax: string | undefined;

export function setEditorSyntax(themeId: string) {
  editorSyntax = themeId;
}

class ShikiState implements languages.IState {
  constructor(readonly stack: StateStack) {}

  // StateStack is immutable, so a state can be shared.
  clone() {
    return this;
  }

  equals(other: languages.IState): boolean {
    if (!(other instanceof ShikiState)) return false;
    if (this.stack === other.stack) return true;
    return !!this.stack && !!other.stack && this.stack.equals(other.stack);
  }
}

const INITIAL = new ShikiState(null);

/** One unstyled token that keeps the line's start state, as when a line is too costly to tokenize. */
function plainLine(state: ShikiState): languages.ILineTokens {
  return { tokens: [{ startIndex: 0, scopes: '' }], endState: state };
}

/** A Monaco tokens provider that runs a Shiki grammar under the committed code theme. */
export function createShikiTokensProvider(
  highlighter: Highlighter,
  grammar: Grammar,
): languages.TokensProvider {
  let names = new Map<number, string>();
  let namesTheme: string | undefined;

  return {
    getInitialState: () => INITIAL,
    tokenize(line, state) {
      // SAFETY: Monaco hands back only the states this provider returned.
      const start = state as ShikiState;
      if (!editorSyntax || line.length > MAX_LINE_LENGTH) return plainLine(start);
      // Chat code blocks share the highlighter and may have left another theme set.
      const { colorMap, theme } = highlighter.setTheme(editorSyntax);
      if (namesTheme !== editorSyntax) {
        names = new Map();
        namesTheme = editorSyntax;
      }

      const result = grammar.tokenizeLine2(line, start.stack, TIME_LIMIT_MS);
      if (result.stoppedEarly) return plainLine(start);

      const tokens: languages.IToken[] = [];
      for (let i = 0; i < result.tokens.length; i += 2) {
        const style = result.tokens[i + 1] & STYLE_MASK;
        let scopes = names.get(style);
        if (scopes === undefined) {
          const colour = normalizeColor(colorMap[(style & FOREGROUND_MASK) >>> 15], theme);
          const fontStyle = (style & FONT_STYLE_MASK) >>> 11;
          scopes = colourToken(colour, fontStyle) + TOKEN_TYPES[(style & TOKEN_TYPE_MASK) >>> 8];
          names.set(style, scopes);
        }
        tokens.push({ startIndex: result.tokens[i], scopes });
      }
      return { tokens, endState: new ShikiState(result.ruleStack) };
    },
  };
}
