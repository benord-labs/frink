import { describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_DEBUG_COMMAND_ID,
  BUILTIN_SLASH_COMMANDS,
  filterBuiltinCommands,
  hiddenInMode,
  insertPickedCommand,
} from '@/lib/commands/builtin-commands';
import type { SlashCommandOption } from '@/lib/commands/types';

describe('filterBuiltinCommands', () => {
  it('returns all commands when search text is empty', () => {
    const results = filterBuiltinCommands('');
    expect(results).toEqual(BUILTIN_SLASH_COMMANDS);
  });

  it('filters by command name', () => {
    const results = filterBuiltinCommands('plan');
    expect(results.some((cmd) => cmd.command === '/plan')).toBe(true);
  });

  it('filters by description', () => {
    const results = filterBuiltinCommands('security');
    expect(results.some((cmd) => cmd.command === '/security-review')).toBe(true);
  });

  it('returns empty array for non-matching search', () => {
    const results = filterBuiltinCommands('zzz-nonexistent-command');
    expect(results).toEqual([]);
  });
});

describe('/debug slash command — project gate', () => {
  it('keeps /debug in the static BUILTIN_SLASH_COMMANDS catalog', () => {
    const debugCmd = BUILTIN_SLASH_COMMANDS.find((cmd) => cmd.command === '/debug');
    expect(debugCmd).toBeDefined();
    expect(debugCmd?.id).toBe(BUILTIN_DEBUG_COMMAND_ID);
  });

  it('excludes /debug from filtered list when hasProject is false', () => {
    const noProject = filterBuiltinCommands('', { hasProject: false });
    expect(noProject.some((cmd) => cmd.id === BUILTIN_DEBUG_COMMAND_ID)).toBe(false);
    expect(noProject).toHaveLength(BUILTIN_SLASH_COMMANDS.length - 1);
  });

  it('filterBuiltinCommands("debug", { hasProject: false }) returns no matches', () => {
    const results = filterBuiltinCommands('debug', { hasProject: false });
    expect(results).toEqual([]);
  });

  it('includes /debug when hasProject is true', () => {
    const results = filterBuiltinCommands('debug', { hasProject: true });
    expect(results).toHaveLength(1);
    expect(results[0].command).toBe('/debug');
  });

  it('does not surface /debug by description search when hasProject is false', () => {
    const results = filterBuiltinCommands('hypothesis', { hasProject: false });
    expect(results.some((cmd) => cmd.command === '/debug')).toBe(false);
  });
});

describe('hiddenInMode', () => {
  it.each([
    ['plan', 'plan', true],
    ['agent', 'plan', false],
    // A goal would keep pushing a plan-mode turn whose edits are all refused.
    ['goal', 'plan', true],
    ['goal', 'agent', false],
  ])('/%s in %s mode → hidden %s', (name, mode, hidden) => {
    expect(hiddenInMode(name, mode)).toBe(hidden);
  });

  it('offers /goal with a plain-language hint for what done looks like', () => {
    expect(filterBuiltinCommands('goal')).toEqual([
      expect.objectContaining({ command: '/goal', argumentHint: 'what done looks like' }),
    ]);
  });
});

describe('insertPickedCommand', () => {
  function editorWith(value: string) {
    return { getValue: () => value, setValue: vi.fn(), setCommandValue: vi.fn() };
  }
  const builtin = (name: string): SlashCommandOption => {
    const found = BUILTIN_SLASH_COMMANDS.find((cmd) => cmd.name === name);
    if (!found) throw new Error(`no built-in ${name}`);
    return found;
  };

  it('starts a /goal line ahead of what is already typed, for Claude to run as written', () => {
    const editor = editorWith('all tests pass');
    insertPickedCommand(editor, builtin('goal'));
    expect(editor.setValue).toHaveBeenCalledWith('/goal all tests pass');
    expect(editor.setCommandValue).not.toHaveBeenCalled();
  });

  it('writes a prompt-based built-in as a command block', () => {
    const editor = editorWith('');
    insertPickedCommand(editor, builtin('review'));
    expect(editor.setCommandValue).toHaveBeenCalledWith(
      'review',
      expect.stringContaining('review'),
    );
  });

  it('writes a custom command body as a command block', () => {
    const editor = editorWith('');
    insertPickedCommand(editor, {
      id: 'custom:frink:user:ship',
      name: 'ship',
      command: '/ship',
      description: 'Ship it',
      category: 'repository',
      prompt: 'Ship the branch',
    });
    expect(editor.setCommandValue).toHaveBeenCalledWith('ship', 'Ship the branch');
  });

  it('writes nothing for a built-in the composer acts on itself', () => {
    const editor = editorWith('');
    insertPickedCommand(editor, builtin('worktree-setup'));
    expect(editor.setValue).not.toHaveBeenCalled();
    expect(editor.setCommandValue).not.toHaveBeenCalled();
  });
});
