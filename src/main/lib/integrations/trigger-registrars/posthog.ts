/** A PostHog HTTP Webhook destination signing per Standard Webhooks with the endpoint secret.
 * `vendor_ref` is `<region>:<team>:<function id>`, so rotate and remove never re-probe the region. */
import { z } from 'zod';
import { standardWebhooksSecret } from '../../../../shared/integrations/webhook-secret';
import type { RegistrarContext, TriggerRegistrar } from './index';
import { VendorRequestError, vendorJson } from './vendor-http';

const REGIONS = { us: 'https://us.posthog.com', eu: 'https://eu.posthog.com' };
type Region = keyof typeof REGIONS;
type Located = { region: Region; team: number; fn: string | null };

const me = z.object({ team: z.object({ id: z.number() }) });
const created = z.object({ id: z.string() });
const page = z.object({
  results: z.array(z.object({ id: z.string(), name: z.string() })),
  next: z.string().nullable(),
});
const detail = z.object({
  inputs: z
    .object({ url: z.object({ value: z.string() }).optional() })
    .nullable()
    .optional(),
});

const VENDOR_REF = /^(us|eu):(\d+):(.+)$/;

function parseRef(ref: string | null): Located | null {
  const match = ref ? VENDOR_REF.exec(ref) : null;
  if (!match) return null;
  return { region: match[1] === 'eu' ? 'eu' : 'us', team: Number(match[2]), fn: match[3] };
}

/** n8n's probe: which PostHog Cloud region takes the token, and its current project. */
async function locate(token: string, storedRef: string | null): Promise<Located> {
  const stored = parseRef(storedRef);
  if (stored) return stored;
  for (const region of ['us', 'eu'] as const) {
    try {
      const user = await vendorJson(
        'PostHog',
        `${REGIONS[region]}/api/users/@me/`,
        { method: 'GET', token },
        me,
      );
      if (user) return { region, team: user.team.id, fn: null };
    } catch (error) {
      if (!(error instanceof VendorRequestError && (error.status === 401 || error.status === 403)))
        throw error;
    }
  }
  throw new VendorRequestError(
    "PostHog didn't accept Frink's access. Frink can only set this up on PostHog Cloud (US or EU); a self-hosted PostHog needs the address pasted in by hand.",
    'users/@me refused on us and eu',
    401,
  );
}

function functionsUrl(located: Located): string {
  return `${REGIONS[located.region]}/api/projects/${located.team}/hog_functions/`;
}

function inputs(ctx: RegistrarContext) {
  return {
    url: { value: ctx.webhookUrl },
    method: { value: 'POST' },
    body: { value: { event: '{event}', person: '{person}' } },
    headers: { value: { 'Content-Type': 'application/json' } },
    signing_secret: { value: standardWebhooksSecret(ctx.endpoint.webhook_secret) },
  };
}

/** checkExists: the "Frink" destination already posting to this address; the list omits inputs, so each candidate is read in full. */
async function checkExists(
  token: string,
  base: string,
  webhookUrl: string,
): Promise<string | null> {
  let next: string | null = `${base}?type=destination&limit=100`;
  while (next) {
    const listed: z.infer<typeof page> | null = await vendorJson(
      'PostHog',
      next,
      { method: 'GET', token },
      page,
    );
    if (!listed) return null;
    for (const candidate of listed.results.filter((fn) => fn.name === 'Frink')) {
      const full = await vendorJson(
        'PostHog',
        `${base}${candidate.id}/`,
        { method: 'GET', token },
        detail,
      );
      if (full?.inputs?.url?.value === webhookUrl) return candidate.id;
    }
    next = listed.next;
  }
  return null;
}

async function stillExists(token: string, base: string, id: string): Promise<boolean> {
  return (await vendorJson('PostHog', `${base}${id}/`, { method: 'GET', token }, detail)) !== null;
}

function ref(located: Located, fn: string): string {
  return `${located.region}:${located.team}:${fn}`;
}

function requireLocated(ctx: RegistrarContext): Located & { fn: string } {
  const located = parseRef(ctx.endpoint.vendor_ref);
  if (!located?.fn) {
    throw new VendorRequestError('This trigger was never set up in PostHog.', 'no vendor_ref');
  }
  return { ...located, fn: located.fn };
}

export const posthogRegistrar: TriggerRegistrar = {
  manualRemoval: 'Delete the "Frink" destination under Data pipeline → Destinations in PostHog.',
  async register(ctx) {
    const { token } = ctx;
    const located = await locate(token, ctx.endpoint.vendor_ref);
    const base = functionsUrl(located);
    const byUrl = await checkExists(token, base, ctx.webhookUrl);
    const id =
      byUrl ?? (located.fn && (await stillExists(token, base, located.fn)) ? located.fn : null);
    if (id) {
      await vendorJson(
        'PostHog',
        `${base}${id}/`,
        { method: 'PATCH', token, json: { enabled: true, inputs: inputs(ctx) } },
        created,
      );
      return { vendorRef: ref(located, id) };
    }
    const made = await vendorJson(
      'PostHog',
      base,
      {
        method: 'POST',
        token,
        json: {
          template_id: 'template-webhook',
          type: 'destination',
          name: 'Frink',
          enabled: true,
          inputs: inputs(ctx),
          filters: {},
        },
      },
      created,
    );
    if (!made)
      throw new VendorRequestError(
        'PostHog did not create the destination.',
        'POST hog_functions → 404',
      );
    return { vendorRef: ref(located, made.id) };
  },
  async rotate(ctx) {
    const located = requireLocated(ctx);
    const patched = await vendorJson(
      'PostHog',
      `${functionsUrl(located)}${located.fn}/`,
      { method: 'PATCH', token: ctx.token, json: { inputs: inputs(ctx) } },
      created,
    );
    if (!patched)
      throw new VendorRequestError('PostHog no longer has this destination.', 'PATCH → 404', 404);
    return {};
  },
  async remove(ctx) {
    const located = requireLocated(ctx);
    await vendorJson(
      'PostHog',
      `${functionsUrl(located)}${located.fn}/`,
      { method: 'PATCH', token: ctx.token, json: { deleted: true } },
      created,
    );
  },
};
