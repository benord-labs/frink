const SENTENCE_END = /[.!?]\s*$/;

/** The draft with dictated words added after it. Each partial result is merged onto the same base,
 *  so a newer partial replaces the older one instead of piling up. */
export function mergeDictation(base: string, transcript: string): string {
  const words = transcript.trim();
  if (!words) return base;
  const startsSentence = !base.trim() || SENTENCE_END.test(base);
  const spoken = startsSentence ? words.charAt(0).toUpperCase() + words.slice(1) : words;
  if (!base.trim()) return spoken;
  return /\s$/.test(base) ? base + spoken : `${base} ${spoken}`;
}
