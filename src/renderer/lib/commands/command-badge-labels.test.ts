import { describe, expect, it } from 'vitest';
import { commandBadgeLabels } from './command-badge-labels';
import type { SlashCommandOption } from './types';

function option(overrides: Partial<SlashCommandOption>): SlashCommandOption {
  return {
    id: 'custom:plugin:user:slack:standup',
    name: 'slack:standup',
    command: '/slack:standup',
    description: 'Draft my standup',
    category: 'repository',
    origin: 'plugin',
    source: 'user',
    ...overrides,
  };
}

describe('commandBadgeLabels', () => {
  it('marks a command whose body consumes $ARGUMENTS', () => {
    expect(commandBadgeLabels(option({ takesArguments: true }))).toEqual(['args', 'plugin']);
  });

  it('leaves a command that takes no arguments unmarked', () => {
    expect(commandBadgeLabels(option({}))).toEqual(['plugin']);
  });

  it('prefers a declared argument-hint over the generic marker', () => {
    const marked = option({ takesArguments: true, argumentHint: '[channel]' });
    expect(commandBadgeLabels(marked)).toEqual(['[channel]', 'plugin']);
  });

  it('falls back to the generic marker when the declared hint is blank', () => {
    const blank = option({ takesArguments: true, argumentHint: '   ' });
    expect(commandBadgeLabels(blank)).toEqual(['args', 'plugin']);
  });

  it('ignores an argument-hint on a body that never reads $ARGUMENTS', () => {
    expect(commandBadgeLabels(option({ argumentHint: '[channel]' }))).toEqual(['plugin']);
  });

  it('drops the origin badge for a frink command but keeps the marker', () => {
    expect(commandBadgeLabels(option({ origin: 'frink', takesArguments: true }))).toEqual(['args']);
  });

  it('names the scope of a non-plugin repository command', () => {
    expect(commandBadgeLabels(option({ origin: 'claude', source: 'project' }))).toEqual([
      'project',
    ]);
    expect(commandBadgeLabels(option({ origin: 'claude', source: 'user' }))).toEqual(['user']);
  });

  it('gives a builtin command no badges at all', () => {
    const builtin = option({ category: 'builtin', origin: undefined, source: undefined });
    expect(commandBadgeLabels(builtin)).toEqual([]);
  });
});
