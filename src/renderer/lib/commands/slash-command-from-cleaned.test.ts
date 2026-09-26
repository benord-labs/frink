import { describe, expect, it } from 'vitest';
import { encodeCommandBlock } from '@/lib/commands/command-block-format';
import { parseSlashCommandFromCleanedText } from '@/lib/commands/slash-command-from-cleaned';

describe('parseSlashCommandFromCleanedText', () => {
  it('extracts name and inner text from a canonical block', () => {
    const raw = encodeCommandBlock('feature-completeness-full', "Please run 'git add'");
    const r = parseSlashCommandFromCleanedText(raw.trim());
    expect(r.commandName).toBe('feature-completeness-full');
    expect(r.commandText).toBe("Please run 'git add'");
    expect(r.cleanedText).toBeNull();
  });

  it('joins surrounding text before and after the block', () => {
    const inner = encodeCommandBlock('build-tests', 'Run tests');
    const raw = `Intro line\n${inner}After line`;
    const r = parseSlashCommandFromCleanedText(raw);
    expect(r.commandName).toBe('build-tests');
    expect(r.commandText).toBe('Run tests');
    expect(r.cleanedText).toBe('Intro line\nAfter line');
  });

  it('returns empty commandText when body is empty between delimiters', () => {
    const raw = '[/cmd:empty]\n\n[/cmd-end]';
    const r = parseSlashCommandFromCleanedText(raw);
    expect(r.commandName).toBe('empty');
    expect(r.commandText).toBe('');
    expect(r.cleanedText).toBeNull();
  });

  it('does not match when [/cmd-end] is missing', () => {
    const raw = '[/cmd:x]\npartial only';
    const r = parseSlashCommandFromCleanedText(raw);
    expect(r.commandName).toBeNull();
    expect(r.commandText).toBeNull();
    expect(r.cleanedText).toBe(raw);
  });
});
