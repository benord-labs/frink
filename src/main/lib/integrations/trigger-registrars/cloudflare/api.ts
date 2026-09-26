/** Fixed Cloudflare API calls through its separately authorized official MCP server. */
import { z } from 'zod';
import manifest from '../../../../../shared/integrations/catalog/cloudflare/plugin.json';
import type { callMcpTool } from '../../../mcp/tools-probe/call';
import { VendorRequestError } from '../vendor-http';
import { beforeTriggerVendorRequest, TriggerOperationError } from '../operation';

export type McpCaller = typeof callMcpTool;
export type ApiRequest = {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  query?: Record<string, string | number>;
  body?: ApiBody;
};
/** Every field Frink sends on a notification destination or policy write. */
type ApiBody = {
  name?: string;
  url?: string;
  secret?: string;
  description?: string;
  enabled?: boolean;
  alert_type?: string;
  alert_interval?: string;
  filters?: Record<string, string[]>;
  mechanisms?: Policy['mechanisms'];
};
const replySchema = z.object({
  isError: z.boolean().optional(),
  content: z.tuple([z.object({ type: z.literal('text'), text: z.string() })]),
});

export function refused(action: string): VendorRequestError {
  return new VendorRequestError(
    "Cloudflare couldn't complete notification setup. Try again.",
    `Cloudflare ${action} failed or returned an unverifiable response`,
  );
}

export async function request<T>(
  caller: McpCaller | undefined,
  token: string,
  input: ApiRequest,
  schema: z.ZodType<T>,
  accountId?: string,
): Promise<T> {
  try {
    await beforeTriggerVendorRequest();
    const call = caller ?? (await import('../../../mcp/tools-probe/call')).callMcpTool;
    // Values are JSON literals, never executable provider/user strings.
    const code = `async () => await cloudflare.request(${JSON.stringify(input)})`;
    const args = accountId ? { code, account_id: accountId } : { code };
    const response = await call(manifest.mcpServers.notifications.url, 'execute', args, {
      Authorization: `Bearer ${token}`,
    });
    if (!response.ok) throw refused(input.method);
    const reply = replySchema.parse(response.result);
    if (reply.isError) throw refused(input.method);
    return schema.parse(JSON.parse(reply.content[0].text));
  } catch (error) {
    // An unconfirmed lease keeps its type so the caller can retry; MCP errors can echo
    // private URLs or secrets, so never forward the response text.
    if (error instanceof TriggerOperationError) throw error;
    throw refused(input.method);
  }
}

export const identifier = z
  .string()
  .regex(/^[a-zA-Z0-9_-]+$/)
  .max(128);
export const destinationSchema = z.object({
  id: identifier,
  name: z.string(),
  url: z.string().url(),
});
export const policySchema = z.object({
  id: identifier,
  name: z.string(),
  enabled: z.boolean(),
  alert_type: z.string().min(1),
  alert_interval: z.string().optional(),
  description: z.string().optional(),
  filters: z.record(z.string(), z.array(z.string())).optional(),
  mechanisms: z.object({
    webhooks: z.array(z.object({ id: identifier })).optional(),
    email: z.array(z.object({ id: z.string() })).optional(),
    pagerduty: z.array(z.object({ id: identifier })).optional(),
  }),
});
export type Policy = z.infer<typeof policySchema>;
export type Destination = z.infer<typeof destinationSchema>;
export const successSchema = z.object({ success: z.literal(true) });
export const resultSchema = <T>(schema: z.ZodType<T>) => successSchema.extend({ result: schema });
export const accountPath = (id: string) => `/accounts/${identifier.parse(id)}/alerting/v3`;

export async function listPolicies(caller: McpCaller | undefined, token: string, account: string) {
  return (
    await request(
      caller,
      token,
      { method: 'GET', path: `${accountPath(account)}/policies` },
      resultSchema(z.array(policySchema)),
      account,
    )
  ).result;
}

export async function listDestinations(
  caller: McpCaller | undefined,
  token: string,
  account: string,
) {
  return (
    await request(
      caller,
      token,
      { method: 'GET', path: `${accountPath(account)}/destinations/webhooks` },
      resultSchema(z.array(destinationSchema)),
      account,
    )
  ).result;
}

export async function eligible(caller: McpCaller | undefined, token: string, account: string) {
  const result = await request(
    caller,
    token,
    { method: 'GET', path: `${accountPath(account)}/destinations/eligible` },
    // The live API returns mechanism objects keyed by "webhooks", unlike its generated array schema.
    resultSchema(
      z.object({
        webhooks: z
          .object({ eligible: z.boolean().optional(), ready: z.boolean().optional() })
          .optional(),
      }),
    ),
    account,
  );
  return result.result.webhooks?.eligible === true && result.result.webhooks.ready === true;
}

export async function accounts(caller: McpCaller | undefined, token: string) {
  const all: { id: string; name: string }[] = [];
  for (let page = 1; ; page++) {
    const result = await request(
      caller,
      token,
      { method: 'GET', path: '/accounts', query: { page, per_page: 50 } },
      resultSchema(z.array(z.object({ id: identifier, name: z.string() }))),
    );
    // Match Cloudflare's SDK: advance page numbers until the API returns an empty result.
    if (!result.result.length) break;
    const seen = new Set(all.map(({ id }) => id));
    for (const account of result.result) {
      if (seen.has(account.id)) throw refused('account pagination');
      seen.add(account.id);
      all.push(account);
    }
  }
  return all;
}
