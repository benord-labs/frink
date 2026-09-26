import { describe, expect, it } from 'vitest';
import { extractQuotedStringAtPosition } from '@/lib/code-editor/files';

describe('extractQuotedStringAtPosition', () => {
  it('returns string inside single quotes when cursor is on the path', () => {
    const line = "import { Foo } from '@/components/Foo';";
    const quoteStart = line.indexOf("'") + 1;
    expect(extractQuotedStringAtPosition(line, quoteStart)).toBe('@/components/Foo');
    expect(extractQuotedStringAtPosition(line, quoteStart + 5)).toBe('@/components/Foo');
    expect(extractQuotedStringAtPosition(line, quoteStart + 17)).toBe('@/components/Foo');
  });

  it('returns string inside double quotes when cursor is on the path', () => {
    const line = 'import styles from "./styles.module.scss";';
    expect(extractQuotedStringAtPosition(line, 22)).toBe('./styles.module.scss');
  });

  it('returns null when cursor is not inside a quoted string', () => {
    const line = "import { Foo } from '@/components/Foo';";
    expect(extractQuotedStringAtPosition(line, 1)).toBeNull();
    expect(extractQuotedStringAtPosition(line, 10)).toBeNull();
    expect(extractQuotedStringAtPosition(line, 40)).toBeNull();
  });

  it('when multiple quoted strings on line, returns the one containing the cursor', () => {
    const line = `const a = 'first'; const b = 'second';`;
    const firstOpen = line.indexOf("'");
    expect(extractQuotedStringAtPosition(line, firstOpen + 1)).toBe('first');
    const secondOpen = line.indexOf("'second'");
    expect(extractQuotedStringAtPosition(line, secondOpen + 1)).toBe('second');
  });

  it('does not match template literals (backticks)', () => {
    const line = 'const path = `@/foo/bar`;';
    const column = line.indexOf('@');
    expect(extractQuotedStringAtPosition(line, column)).toBeNull();
  });

  it('returns path for @import in CSS/SCSS', () => {
    const line = "  @import '@/styles/variables';";
    expect(extractQuotedStringAtPosition(line, 14)).toBe('@/styles/variables');
  });

  it('returns path for url() in CSS', () => {
    const line = '  background: url("../assets/bg.png");';
    expect(extractQuotedStringAtPosition(line, 22)).toBe('../assets/bg.png');
  });

  it('returns null via extractQuotedStringAtPosition when the string has no closing delimiter', () => {
    const line = 'import bad from "/broken/path';
    const column = line.indexOf('/broken/path') + 1;
    expect(extractQuotedStringAtPosition(line, column)).toBeNull();
  });

  it('returns null via extractQuotedStringAtPosition when opening and closing quote delimiters mismatch', () => {
    const line = `import bad from 'broken/path";`;
    const column = line.indexOf('broken') + 1;
    expect(extractQuotedStringAtPosition(line, column)).toBeNull();
  });

  it('allows apostrophe inside double-quoted string', () => {
    const line = 'const msg = "it\'s fine";';
    const column = line.indexOf('it');
    expect(extractQuotedStringAtPosition(line, column)).toBe("it's fine");
  });

  it('allows double quotes inside single-quoted string', () => {
    const line = `const msg = 'say "hi"';`;
    const column = line.indexOf('say');
    expect(extractQuotedStringAtPosition(line, column)).toBe('say "hi"');
  });

  it('uses 1-based column index like Monaco (raw 0-based index of opening quote misses the span)', () => {
    const line = "import { Foo } from '@/x';";
    const openQuoteIdx = line.indexOf("'");
    expect(extractQuotedStringAtPosition(line, openQuoteIdx)).toBeNull();
    expect(extractQuotedStringAtPosition(line, openQuoteIdx + 1)).toBe('@/x');
  });
});
