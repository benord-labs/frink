import { describe, expect, it } from 'vitest';
import {
  envelopeBodyParts,
  MOBILE_ENVELOPE_PART_BYTES,
  mobileEnvelopeSchema,
} from './mobile-envelope';

const part = (body: string) => ({ t: 'req', id: 1, body, end: true });

describe('mobile envelope parts', () => {
  it('accepts every part the splitter makes, and nothing that decodes past the cap', () => {
    for (const piece of envelopeBodyParts(new Uint8Array(MOBILE_ENVELOPE_PART_BYTES * 2 + 1)))
      expect(mobileEnvelopeSchema.safeParse(part(piece.body)).success).toBe(true);
    const over = btoa('x'.repeat(MOBILE_ENVELOPE_PART_BYTES + 1));
    expect(mobileEnvelopeSchema.safeParse(part(over)).success).toBe(false);
    // Same encoded length as a full part, but no padding: 131,073 bytes.
    const unpadded = 'A'.repeat(Math.ceil(MOBILE_ENVELOPE_PART_BYTES / 3) * 4);
    expect(mobileEnvelopeSchema.safeParse(part(unpadded)).success).toBe(false);
  });

  it('accepts a live event up to the part cap and refuses one past it', () => {
    const event = (body: string) => ({ t: 'evt', sub: crypto.randomUUID(), seq: 1, body });
    const [full] = envelopeBodyParts(new Uint8Array(MOBILE_ENVELOPE_PART_BYTES));
    expect(mobileEnvelopeSchema.safeParse(event(full.body)).success).toBe(true);
    const over = btoa('x'.repeat(MOBILE_ENVELOPE_PART_BYTES + 1));
    expect(mobileEnvelopeSchema.safeParse(event(over)).success).toBe(false);
    expect(mobileEnvelopeSchema.safeParse({ ...event(''), sub: 'not-a-uuid' }).success).toBe(false);
  });
});
