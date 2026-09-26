import { describe, expect, it } from 'vitest';
import { expandBriefingMentions } from './expand-briefing-mentions';

/**
 * Simulates the frontend token encoding: btoa(unescape(encodeURIComponent(text))).
 * In Node.js, Buffer.from(text, 'utf-8').toString('base64') produces identical output
 * because both encode the raw UTF-8 byte sequence as base64.
 */
function toBase64(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64');
}

function makeBriefingToken(flowId: string, name: string, briefingText: string): string {
  return `@[briefing:${flowId}:${toBase64(name)}:${toBase64(briefingText)}]`;
}

const UUID = '550e8400-e29b-41d4-a716-446655440001';
const UUID2 = '550e8400-e29b-41d4-a716-446655440002';

describe('expandBriefingMentions', () => {
  describe('basic expansion', () => {
    it('expands a single ASCII briefing token inline', () => {
      const token = makeBriefingToken(UUID, 'My Flow', 'Use strict mode always.');
      const result = expandBriefingMentions(`Hello ${token} world`);
      expect(result).toBe(
        'Hello \n---\n## Briefing: My Flow\nUse strict mode always.\n---\n world',
      );
    });

    it('produces correct separator format', () => {
      const token = makeBriefingToken(UUID, 'Test', 'content');
      expect(expandBriefingMentions(token)).toBe('\n---\n## Briefing: Test\ncontent\n---\n');
    });

    it('handles briefing text containing markdown and newlines', () => {
      const briefingText = '# Spec\n\n- Step 1\n- Step 2\n\n**Always** use TypeScript.';
      const token = makeBriefingToken(UUID, 'My Flow', briefingText);
      const result = expandBriefingMentions(token);
      expect(result).toContain('# Spec');
      expect(result).toContain('- Step 1');
      expect(result).toContain('**Always** use TypeScript.');
    });
  });

  describe('Unicode / UTF-8 round-trip', () => {
    it('expands Unicode flow name correctly', () => {
      const token = makeBriefingToken(UUID, '日本語フロー', 'Some briefing text');
      const result = expandBriefingMentions(token);
      expect(result).toContain('## Briefing: 日本語フロー');
      expect(result).toContain('Some briefing text');
    });

    it('expands Unicode briefing text correctly', () => {
      const token = makeBriefingToken(
        UUID,
        'My Flow',
        'Spec: 日本語テスト。Always use TypeScript。',
      );
      const result = expandBriefingMentions(token);
      expect(result).toContain('Spec: 日本語テスト。Always use TypeScript。');
    });

    it('expands flow name and text containing emoji', () => {
      const token = makeBriefingToken(UUID, 'Emoji Flow 🚀', 'Always ✅ test first');
      const result = expandBriefingMentions(token);
      expect(result).toContain('## Briefing: Emoji Flow 🚀');
      expect(result).toContain('Always ✅ test first');
    });
  });

  describe('multiple tokens', () => {
    it('expands all tokens when multiple briefings appear in one prompt', () => {
      const t1 = makeBriefingToken(UUID, 'Flow A', 'Briefing A');
      const t2 = makeBriefingToken(UUID2, 'Flow B', 'Briefing B');
      const result = expandBriefingMentions(`${t1} some text ${t2}`);
      expect(result).toContain('## Briefing: Flow A');
      expect(result).toContain('## Briefing: Flow B');
      expect(result).toContain('Briefing A');
      expect(result).toContain('Briefing B');
    });

    it('expands the same token twice when inserted twice (duplicate content)', () => {
      const token = makeBriefingToken(UUID, 'My Flow', 'Briefing text');
      const result = expandBriefingMentions(`${token} ${token}`);
      const occurrences = result.split('## Briefing: My Flow').length - 1;
      expect(occurrences).toBe(2);
    });
  });

  describe('other mention types untouched', () => {
    it('leaves prompt unchanged when no briefing tokens present', () => {
      const prompt = 'Hello @[file:repo:/some/path] world';
      expect(expandBriefingMentions(prompt)).toBe(prompt);
    });

    it('does not expand file, skill, or agent mentions', () => {
      const briefingToken = makeBriefingToken(UUID, 'My Flow', 'text');
      const fileToken = '@[file:repo:/path/to/file.ts]';
      const skillToken = '@[skill:my-skill]';
      const prompt = `${fileToken} ${briefingToken} ${skillToken}`;
      const result = expandBriefingMentions(prompt);
      expect(result).toContain(fileToken);
      expect(result).toContain(skillToken);
      expect(result).not.toContain('@[briefing:');
      expect(result).toContain('## Briefing: My Flow');
    });

    it('returns empty string unchanged', () => {
      expect(expandBriefingMentions('')).toBe('');
    });
  });

  describe('malformed tokens', () => {
    it('leaves token with only one colon segment (no base64 parts) unchanged', () => {
      const token = `@[briefing:${UUID}:onlyone]`;
      expect(expandBriefingMentions(token)).toBe(token);
    });

    it('leaves token with no colon after briefing: prefix unchanged', () => {
      const token = '@[briefing:noColonHereAtAll]';
      expect(expandBriefingMentions(token)).toBe(token);
    });

    it('expands tokens with invalid base64 chars to empty name/text without throwing', () => {
      // Buffer.from('!!!', 'base64') silently returns empty Buffer — no exception raised.
      // The token is "expanded" to an empty briefing block rather than preserved as-is.
      const token = `@[briefing:${UUID}:!!!:!!!]`;
      const result = expandBriefingMentions(token);
      expect(result).toBe('\n---\n## Briefing: \n\n---\n');
    });
  });
});
