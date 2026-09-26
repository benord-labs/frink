import { describe, expect, it } from 'vitest';
import { CLAUDE_CODE_MODELS, CLAUDE_MODEL_ID_MAP } from '../../../../shared/lib/models';

/** Aliased so the assertions read as the picker's id → CLI value lookup. */
const MODEL_ID_MAP = CLAUDE_MODEL_ID_MAP;

describe('MODEL_ID_MAP edge cases', () => {
  describe('Edge Case: Complete Coverage (High)', () => {
    it('includes all Claude Code model IDs', () => {
      for (const model of CLAUDE_CODE_MODELS) {
        expect(MODEL_ID_MAP).toHaveProperty(model.id);
      }
    });

    it('maps Claude Opus effort variants to version-pinned Anthropic IDs', () => {
      expect(MODEL_ID_MAP['opus-low']).toBe('claude-opus-4-6');
      expect(MODEL_ID_MAP['opus-high']).toBe('claude-opus-4-6');
      expect(MODEL_ID_MAP['opus-4.7-low']).toBe('claude-opus-4-7');
      expect(MODEL_ID_MAP['opus-4.7-high']).toBe('claude-opus-4-7');
      expect(MODEL_ID_MAP['sonnet-low']).toBe('sonnet');
      expect(MODEL_ID_MAP['sonnet-high']).toBe('sonnet');
    });

    it('maps Claude context tier variants to CLI values', () => {
      expect(MODEL_ID_MAP['opus-1m']).toBe('claude-opus-4-6');
      expect(MODEL_ID_MAP['opus-4.7-1m']).toBe('claude-opus-4-7');
      expect(MODEL_ID_MAP['sonnet-1m']).toBe('sonnet');
    });

    it('maps Claude base variants to CLI values', () => {
      expect(MODEL_ID_MAP.opus).toBe('claude-opus-4-6');
      expect(MODEL_ID_MAP['opus-4.7']).toBe('claude-opus-4-7');
      expect(MODEL_ID_MAP['opus-4.8']).toBe('claude-opus-4-8');
      expect(MODEL_ID_MAP['opus-5.5']).toBe('claude-opus-5-5');
      expect(MODEL_ID_MAP['opus-5']).toBe('claude-opus-5');
      expect(MODEL_ID_MAP['fable-5.1']).toBe('claude-fable-5-1');
      expect(MODEL_ID_MAP.sonnet).toBe('sonnet');
      expect(MODEL_ID_MAP.haiku).toBe('haiku');
    });

    it('has no undefined or null values', () => {
      for (const [key, value] of Object.entries(MODEL_ID_MAP)) {
        expect(value, `${key} has undefined/null value`).toBeTruthy();
        expect(typeof value).toBe('string');
      }
    });
  });

  describe('Edge Case: No ID Collisions (Medium)', () => {
    it('has unique Claude model IDs', () => {
      const ids = CLAUDE_CODE_MODELS.map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('MODEL_ID_MAP size matches the number of Claude models', () => {
      expect(Object.keys(MODEL_ID_MAP).length).toBe(CLAUDE_CODE_MODELS.length);
    });
  });

  describe('Edge Case: Backward Compatibility (Medium)', () => {
    it('legacy unversioned Opus id still resolves (now pinned to claude-opus-4-6)', () => {
      // Saved chats may reference `opus` from before the 4.6/4.7 split — keep it resolvable.
      const legacyMappings: Record<string, string> = {
        opus: 'claude-opus-4-6',
        sonnet: 'sonnet',
        haiku: 'haiku',
      };

      for (const [id, expected] of Object.entries(legacyMappings)) {
        expect(MODEL_ID_MAP[id]).toBe(expected);
      }
    });
  });
});
