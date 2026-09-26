import { describe, expect, it } from 'vitest';
import {
  BUILTIN_DEBUG_COMMAND_ID,
  BUILTIN_SLASH_COMMANDS,
  filterBuiltinCommands,
} from '@/lib/commands/builtin-commands';

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
