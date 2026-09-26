import { describe, expect, it } from 'vitest';
import { fillCommandArguments } from './fill-command-arguments';

describe('fillCommandArguments', () => {
  it('replaces every occurrence', () => {
    expect(fillCommandArguments('Ship $ARGUMENTS to $ARGUMENTS', 'staging')).toBe(
      'Ship staging to staging',
    );
  });

  it('lands $& and $$ verbatim instead of reinterpreting them as replacement patterns', () => {
    expect(fillCommandArguments('cost: $ARGUMENTS', '$$5 & $& more')).toBe('cost: $$5 & $& more');
  });

  it('empties the placeholder when no arguments were given', () => {
    expect(fillCommandArguments('Channel: $ARGUMENTS.', '')).toBe('Channel: .');
  });

  it('leaves a body with no placeholder untouched', () => {
    expect(fillCommandArguments('Summarise my day.', 'ignored')).toBe('Summarise my day.');
  });
});
