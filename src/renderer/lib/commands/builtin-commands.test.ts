import { describe, expect, it } from 'vitest';
import {
  BUILTIN_DEBUG_COMMAND_ID,
  BUILTIN_SLASH_COMMANDS,
  COMMAND_PROMPTS,
  filterBuiltinCommands,
  slashCommandInsertText,
} from '@/lib/commands/builtin-commands';
import type { SlashCommandOption } from '@/lib/commands/types';
import { BUILTIN_COMMAND_NAMES } from '../../../shared/commands/builtin-command-names';

const builtin = (name: string): SlashCommandOption => {
  const option = BUILTIN_SLASH_COMMANDS.find((cmd) => cmd.name === name);
  if (!option) throw new Error(`no built-in /${name}`);
  return option;
};

const repositoryCommand = (name: string, prompt?: string): SlashCommandOption => ({
  id: `repo:${name}`,
  name,
  command: `/${name}`,
  description: '',
  category: 'repository',
  prompt,
});

describe('slashCommandInsertText', () => {
  it('inserts the canned prompt for a prompt-based built-in', () => {
    expect(slashCommandInsertText(builtin('review'))).toBe(COMMAND_PROMPTS.review);
  });

  it('inserts the setup prompt for /worktree-setup, which previously inserted nothing', () => {
    expect(slashCommandInsertText(builtin('worktree-setup'))).toBe(
      COMMAND_PROMPTS['worktree-setup'],
    );
  });

  it('inserts nothing for a mode-switching built-in', () => {
    expect(slashCommandInsertText(builtin('plan'))).toBeUndefined();
    expect(slashCommandInsertText(builtin('compact'))).toBeUndefined();
  });

  it("inserts a repository command's own body even when it shares a built-in's name", () => {
    expect(slashCommandInsertText(repositoryCommand('review', 'My review checklist'))).toBe(
      'My review checklist',
    );
  });

  it('inserts nothing for a repository command without a body', () => {
    expect(slashCommandInsertText(repositoryCommand('empty'))).toBeUndefined();
  });
});

describe('built-in command catalog', () => {
  it('lists exactly the names the command expanders skip', () => {
    expect(BUILTIN_SLASH_COMMANDS.map((cmd) => cmd.name)).toEqual([...BUILTIN_COMMAND_NAMES]);
  });

  it('has no /commit built-in', () => {
    expect(filterBuiltinCommands('commit')).toEqual([]);
    expect(COMMAND_PROMPTS).not.toHaveProperty('commit');
  });
});

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
