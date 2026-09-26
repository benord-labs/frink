/** Every address is `/api/triggers/<provider>/<token>` on whatever base this machine answers on:
 * the one receiver behind every row that declares `webhook_payload`. */
export function webhookUrlOn(base: string, provider: string, webhookPathToken: string): string {
  return `${base}/api/triggers/${encodeURIComponent(provider)}/${encodeURIComponent(webhookPathToken)}`;
}
