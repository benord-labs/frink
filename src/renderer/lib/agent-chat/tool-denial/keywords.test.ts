import { describe, expect, it } from 'vitest';
import {
  matchesToolDenialKeyword,
  TOOL_DENIAL_KEYWORDS,
} from '@/lib/agent-chat/tool-denial/keywords';

describe('matchesToolDenialKeyword', () => {
  it.each(TOOL_DENIAL_KEYWORDS)('matches the %s marker', (keyword) => {
    expect(matchesToolDenialKeyword(`Tool call ${keyword} for this chat.`)).toBe(true);
  });

  it('matches regardless of case', () => {
    expect(matchesToolDenialKeyword('Virtual folders are READ-ONLY.')).toBe(true);
  });

  it('does not match an ordinary tool failure', () => {
    expect(matchesToolDenialKeyword('TypeError: flag is not valid')).toBe(false);
    expect(matchesToolDenialKeyword('Command not found: poetry')).toBe(false);
  });

  it('does not match empty text', () => {
    expect(matchesToolDenialKeyword('')).toBe(false);
  });

  it('covers the real denial reasons producers emit', () => {
    // Sourced from main/lib/permissions — the strings this shim exists to classify.
    expect(matchesToolDenialKeyword('Bash command denied by policy.')).toBe(true);
    expect(
      matchesToolDenialKeyword(
        'Virtual folders are read-only. "git push" requires a project context.',
      ),
    ).toBe(true);
    expect(matchesToolDenialKeyword('Write is blocked in read-only mode (virtual folder).')).toBe(
      true,
    );
  });
});
