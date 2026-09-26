/** The vendor adapters and which one this machine runs for a provider. The endpoint row, its lease
 * and the address's base belong to the caller (`webhooks/local-registrars`). */
import { getProviderById } from '../../../../shared/integrations/selectors';
import type { Provider } from '../../../../shared/integrations/types';
import { readToken, type TriggerCredential } from './credentials';
import { huggingfaceRegistrar } from './huggingface';
import { clickupRegistrar } from './clickup';
import { cloudflareRegistrar } from './cloudflare';
import { posthogRegistrar } from './posthog';
import { webflowRegistrar } from './webflow';

export type RegistrarContext = {
  provider: Provider;
  integration: { id: string; external_workspace_id: string | null };
  endpoint: { id: string; webhook_secret: string; vendor_ref: string | null };
  webhookUrl: string;
  token: string;
  selection?: string[];
  /** Persist cleanup scope before a remote mutation whose outcome may be lost. */
  saveProgress?: (vendorRef: string) => Promise<void>;
};

/** One vendor's subscription API. `register` is idempotent: match by URL, then by stored id, then create. */
export type TriggerSetupOptions = {
  options: { id: string; label: string; description?: string }[];
  selection: 'one' | 'many';
};

export interface TriggerRegistrar {
  setupOptions?: (ctx: { token: string }) => Promise<TriggerSetupOptions>;
  /** Remote mutations can succeed before their response is received; these adapters discover by URL. */
  canDiscoverSubscriptions?: boolean;
  /** The vendor generates its signing secret; do not rotate the local copy before vendor success. */
  issuesSigningSecret?: boolean;
  register(ctx: RegistrarContext): Promise<{ vendorRef: string; secret?: string }>;
  /** The endpoint row already carries the rotated secret; a vendor that mints its own returns it. */
  rotate(ctx: RegistrarContext): Promise<{ secret?: string; vendorRef?: string }>;
  /** Already gone at the vendor = success. */
  remove(ctx: RegistrarContext): Promise<void>;
  /** What the user does by hand when Frink cannot remove the subscription. */
  manualRemoval: string;
}

export type RegistrationResult =
  | { ok: true }
  | { ok: false; reason: string; retryRequired?: boolean };

export type MainRegistrar = {
  registrar: TriggerRegistrar;
  credential: TriggerCredential;
  mcpServerId?: string;
};

const ADAPTERS = {
  clickup: clickupRegistrar,
  huggingface: huggingfaceRegistrar,
  cloudflare: cloudflareRegistrar,
  posthog: posthogRegistrar,
  webflow: webflowRegistrar,
};

/** The adapter main runs for this row; null when the user pastes the address instead. */
export function mainRegistrar(provider: Provider | undefined): MainRegistrar | null {
  const spec = provider?.subscription === 'auto' ? provider.registrar : undefined;
  if (!spec) return null;
  return {
    registrar: ADAPTERS[spec.adapter],
    credential: spec.credential,
    mcpServerId: spec.mcpServerId,
  };
}

/** Discover vendor-owned choices using the same grant that registers subscriptions. */
export async function getTriggerSetupOptions(
  integration: { provider: string; api_token_encrypted?: string | null },
  apiToken?: string,
): Promise<TriggerSetupOptions> {
  const provider = getProviderById(integration.provider);
  const main = mainRegistrar(provider);
  if (!provider || !main?.registrar.setupOptions)
    throw new Error('This trigger has no setup choices.');
  return main.registrar.setupOptions({
    token: apiToken ?? (await readToken(provider, integration, main.credential, main.mcpServerId)),
  });
}
