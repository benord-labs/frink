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
});
