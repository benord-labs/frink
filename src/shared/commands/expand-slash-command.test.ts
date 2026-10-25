import { describe, expect, it, vi } from 'vitest';
import { encodeCommandBlock } from './command-block-format';
import { expandSlashCommand, isCompactCommand } from './expand-slash-command';

/**
 * Callers rely on expansion never throwing and never losing the user's input:
 * a failed lookup must resolve to the original text so the message still sends
 * verbatim rather than disappearing or surfacing an error mid-send.
 */
const fetcherWith = (overrides: Partial<Parameters<typeof expandSlashCommand>[2]>) => ({
  listCommands: vi.fn(async () => [{ name: 'deploy', path: '/cmds/deploy.md' }]),
  getContent: vi.fn(async () => 'Ship $ARGUMENTS to $ARGUMENTS'),
  ...overrides,
});

describe('expandSlashCommand', () => {
  it('substitutes every $ARGUMENTS occurrence with the trimmed args', async () => {
    const result = await expandSlashCommand('/deploy  staging  ', undefined, fetcherWith({}));
    expect(result).toBe('Ship staging to staging');
  });

  it('returns the original text when the command listing fails', async () => {
    const fetcher = fetcherWith({
      listCommands: vi.fn(async () => {
        throw new Error('IPC down');
      }),
    });
    expect(await expandSlashCommand('/deploy staging', undefined, fetcher)).toBe('/deploy staging');
  });

  it('returns the original text when reading the command body fails', async () => {
    const fetcher = fetcherWith({
      getContent: vi.fn(async () => {
        throw new Error('ENOENT');
      }),
    });
    expect(await expandSlashCommand('/deploy staging', undefined, fetcher)).toBe('/deploy staging');
  });

  it('leaves built-in commands alone without consulting the fetcher', async () => {
    const fetcher = fetcherWith({});
    expect(await expandSlashCommand('/review this diff', undefined, fetcher)).toBe(
      '/review this diff',
    );
    expect(fetcher.listCommands).not.toHaveBeenCalled();
  });

  it('returns the original text when no command matches', async () => {
    const fetcher = fetcherWith({ listCommands: vi.fn(async () => []) });
    expect(await expandSlashCommand('/unknown args', undefined, fetcher)).toBe('/unknown args');
  });

  it('leaves plain messages untouched without consulting the fetcher', async () => {
    const fetcher = fetcherWith({});
    expect(await expandSlashCommand('just a message', undefined, fetcher)).toBe('just a message');
    expect(fetcher.listCommands).not.toHaveBeenCalled();
  });

  it('expands a namespaced plugin command typed by name', async () => {
    const fetcher = fetcherWith({
      listCommands: vi.fn(async () => [
        { name: 'slack:summarize-channel', path: '/vendor/slack/commands/summarize-channel.md' },
      ]),
      getContent: vi.fn(async () => 'Given the channel in $ARGUMENTS (strip #):'),
    });
    expect(await expandSlashCommand('/slack:summarize-channel #general', undefined, fetcher)).toBe(
      'Given the channel in #general (strip #):',
    );
  });

  it('keeps $$ and $& in typed args verbatim', async () => {
    const fetcher = fetcherWith({ getContent: vi.fn(async () => 'Ship $ARGUMENTS') });
    expect(await expandSlashCommand('/deploy $$ and $&', undefined, fetcher)).toBe(
      'Ship $$ and $&',
    );
  });
});

describe('a dropdown-selected [/cmd] block is already complete', () => {
  const block = encodeCommandBlock('slack:summarize-channel', 'Channel: #general. Read #general.');

  it('leaves the block alone and delivers what follows it as the user message', async () => {
    // Arguments are collected before insertion, so trailing text is a message, never a payload.
    const fetcher = fetcherWith({});
    const text = `${block}can you also flag anything urgent`;
    expect(await expandSlashCommand(text, undefined, fetcher)).toBe(text);
    expect(fetcher.listCommands).not.toHaveBeenCalled();
  });

  it('leaves a block alone wherever it sits in the message', async () => {
    const led = `hello\n${block}`;
    expect(await expandSlashCommand(led, undefined, fetcherWith({}))).toBe(led);
  });

  it('leaves two blocks alone', async () => {
    const two = `${block}${encodeCommandBlock('slack:standup', 'Standup.')}`;
    expect(await expandSlashCommand(two, undefined, fetcherWith({}))).toBe(two);
  });
});

describe('isCompactCommand', () => {
  it('matches a bare invocation and one carrying summarization instructions', () => {
    expect(isCompactCommand('/compact')).toBe(true);
    expect(isCompactCommand('/compact  ')).toBe(true);
    expect(isCompactCommand('/compact keep the API decisions')).toBe(true);
    // Case-sensitive: the provider's own findCommand compares with ===, so /COMPACT is not a
    // command there and accepting it would strip context for a prompt it then rejects.
    expect(isCompactCommand('/COMPACT')).toBe(false);
    expect(isCompactCommand('/Compact')).toBe(false);
  });

  it('does not match when whitespace precedes the command', () => {
    // Callers pass the matched text through unchanged, so a leading space would reach the provider
    // at position 1 and never dispatch.
    expect(isCompactCommand('  /compact')).toBe(false);
    expect(isCompactCommand('\t/compact')).toBe(false);
  });

  it('does not match text that merely contains the command', () => {
    // The provider dispatches only on a leading slash, so anything that puts characters ahead of
    // `/compact` is an ordinary message — the exact failure this predicate exists to prevent.
    expect(isCompactCommand('@[file:local:/a.ts] /compact')).toBe(false);
    expect(isCompactCommand('please run /compact')).toBe(false);
    expect(isCompactCommand('/compaction')).toBe(false);
    expect(isCompactCommand('/compact-now')).toBe(false);
  });

  it('matches instructions that span multiple lines', () => {
    // SLASH_COMMAND_REGEX is dotAll, and /compact takes free-text summarization instructions —
    // a pasted multi-line brief is a normal way to invoke it, not a malformed command.
    expect(isCompactCommand('/compact keep the API decisions\nand the migration plan')).toBe(true);
  });

  it('does not match when a newline precedes the command', () => {
    // .trim() removes surrounding whitespace, but an earlier LINE means the command is not at
    // position 0 of the prompt, which is the only place a provider dispatches it.
    expect(isCompactCommand('some context\n/compact')).toBe(false);
  });

  it('does not match other builtin commands', () => {
    // They consume the context a caller would otherwise suppress; only /compact is exempt.
    expect(isCompactCommand('/review')).toBe(false);
    expect(isCompactCommand('/plan')).toBe(false);
    expect(isCompactCommand('')).toBe(false);
  });
});
