const BRIEFING_MENTION_REGEX = /@\[briefing:[^\]]+\]/g;

/**
 * Expand @[briefing:...] tokens in the prompt to human-readable text before
 * it is sent to Claude. Called before parseMentions() in the prompt pipeline.
 *
 * Token format: @[briefing:<flowId>:<base64Name>:<base64Text>]
 * Encoding: btoa(unescape(encodeURIComponent(text))) — equivalent to
 *   Buffer.from(text, 'utf-8').toString('base64'), handles all Unicode.
 * Expanded to: "\n---\n## Briefing: <flowName>\n<briefingText>\n---\n"
 */
export function expandBriefingMentions(prompt: string): string {
  return prompt.replace(BRIEFING_MENTION_REGEX, (token) => {
    // Colon-parse `flowId:base64Name:base64Text` after removing the `@[…]` wrapper and `briefing:` prefix.
    const inner = token.slice(2, -1); // Strip the `@[` … `]` wrapper (token is `@[…]`).
    const withoutPrefix = inner.slice('briefing:'.length); // Drop `briefing:`; remainder is three colon-separated parts.
    const firstColon = withoutPrefix.indexOf(':'); // Separates flow id from `base64Name:base64Text`.
    if (firstColon === -1) return token; // Malformed — no colon after flow id.
    const afterFlowId = withoutPrefix.slice(firstColon + 1); // Everything after `flowId:` (name + text segments).
    const secondColon = afterFlowId.indexOf(':'); // Separates base64 flow name from base64 briefing body.
    if (secondColon === -1) return token; // Malformed — missing colon between name and text.
    try {
      const flowName = Buffer.from(afterFlowId.slice(0, secondColon), 'base64').toString('utf-8');
      const briefingText = Buffer.from(afterFlowId.slice(secondColon + 1), 'base64').toString(
        'utf-8',
      );
      return `\n---\n## Briefing: ${flowName}\n${briefingText}\n---\n`;
    } catch {
      return token; // Malformed — leave as-is
    }
  });
}
