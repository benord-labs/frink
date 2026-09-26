import { describe, expect, it } from 'vitest';
import { encodeForMentionToken } from '@/lib/mentions/briefing-base64';
import { parseBriefingMentionLabel } from '@/lib/mentions/briefing-mention-from-id';

const FLOW_UUID = '550e8400-e29b-41d4-a716-446655440001';

describe('parseBriefingMentionLabel', () => {
  it('returns null for empty string input', () => {
    expect(parseBriefingMentionLabel('')).toBeNull();
  });

  it('returns Briefing for prefix-only token briefing:', () => {
    expect(parseBriefingMentionLabel('briefing:')).toBe('Briefing');
  });

  it("falls back to Briefing when name segment decodes to empty (e.g. encodeForMentionToken(''))", () => {
    const nameB64 = encodeForMentionToken('');
    expect(nameB64).toBe('');
    const id = `briefing:${FLOW_UUID}:${nameB64}`;
    expect(parseBriefingMentionLabel(id)).toBe('Briefing');
  });

  it('returns null for non-briefing ids', () => {
    expect(parseBriefingMentionLabel('file:repo:path')).toBeNull();
  });

  it('decodes flow name from minimal two-segment token (flowId + base64 name only)', () => {
    const nameB64 = encodeForMentionToken('My Flow');
    const id = `briefing:${FLOW_UUID}:${nameB64}`;
    expect(parseBriefingMentionLabel(id)).toBe('My Flow');
  });

  it('decodes flow name from full four-segment token (name + briefing text)', () => {
    const nameB64 = encodeForMentionToken('Spec');
    const textB64 = encodeForMentionToken('Do the thing');
    const id = `briefing:${FLOW_UUID}:${nameB64}:${textB64}`;
    expect(parseBriefingMentionLabel(id)).toBe('Spec');
  });

  it('uses Briefing when only flowId segment is present after the prefix', () => {
    const id = `briefing:${FLOW_UUID}`;
    expect(parseBriefingMentionLabel(id)).toBe('Briefing');
  });

  it('uses Briefing label when decode fails (invalid base64)', () => {
    const id = `briefing:${FLOW_UUID}:!!!`;
    expect(parseBriefingMentionLabel(id)).toBe('Briefing');
  });
});
