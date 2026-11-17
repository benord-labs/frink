import type { LAUNCH_FLAGS } from '../launch-flags';
import type { JsonValue } from '../types/permissions';

type LaunchFlagKey = keyof typeof LAUNCH_FLAGS;

type ProviderCategory =
  | 'ticketing'
  | 'messaging'
  | 'code'
  | 'crm'
  | 'analytics'
  | 'infrastructure'
  | 'payments'
  | 'custom';

export type PayloadExtractorId = 'shortcut' | 'linear' | 'generic';

export interface EventSpec {
  id: string;
  label: string;
  /** One sentence: what fires this event, phrased for the plugin detail page. */
  description?: string;
  /** Provider-side setup the event needs before it can fire (invite, scope, subscription). */
  requirement?: string;
  filter_field_ids: ReadonlyArray<string>;
  /** The event's payload carries assignee ids, so a trigger on it can be narrowed to one person. */
  assignee?: true;
  /**
   * Data-driven rows only (`webhook_payload`): the vendor strings at `event_type_path` this
   * intent stands for. Absent = the row's catch-all, which any unlisted string resolves to.
   */
  vendor_events?: ReadonlyArray<string>;
}

export interface FilterField {
  id: string;
  label: string;
  value_source: 'static_enum' | 'api_lookup' | 'text';
  static_values?: ReadonlyArray<string>;
  /** Data-driven rows only: the body path whose value the receiver puts under this id for matching. */
  path?: string;
}

/** How the shared receiver reads a webhook-only vendor's POST body: dot paths into the parsed JSON.
 * A new vendor of this shape is a row, never a code file. */
export interface WebhookPayloadSpec {
  /** Path to the string naming the vendor event; missing or not a string → the row's catch-all event. */
  event_type_path?: string;
  /** Path to the per-delivery id, so a vendor redelivery replays instead of re-running; absent → a body hash. */
  event_id_path?: string;
  /** Path to the vendor-side id of the person the event concerns (`externalUserId`). */
  owner_path?: string;
  /** Where an assignee event lists who was assigned: the path to a list in the body, and the path
   * to the id inside each item. An item with no id there (a removal) adds nobody. */
  owner_ids?: { list_path: string; id_path: string };
  /** The signature required on every delivery; absent means the receiver forwards nothing. Each
   * variant names the scheme its verifier in `src/shared/webhooks/signatures/` implements. */
  signature?:
    | 'frink_hmac'
    | 'standard_webhooks'
    | 'notion'
    | 'square'
    | 'vercel'
    | 'sentry'
    | { hex_hmac_header: string }
    | { secret_header: string };
}

/** How a trigger's subscription is established: `auto` (Frink registers it) or `paste_url` (the
 * user pastes the address). */
type TriggerSubscription = 'auto' | 'paste_url';

/** Who arms an `auto` subscription: the main-process adapter named here, using the credential it
 * names. Required exactly when `subscription` is `auto`. */
type TriggerRegistrar = {
  adapter: 'posthog' | 'webflow' | 'cloudflare' | 'clickup' | 'huggingface';
  credential: 'mcp' | 'api_token';
  mcpServerId?: string;
  setup?: 'resources' | 'api_token';
  /** Named resources when the vendor cannot enumerate the scope the user may watch. */
  resourceTypes?: ReadonlyArray<{ id: string; label: string }>;
  tokenSetup?: {
    label: string;
    url: `https://${string}`;
    resourceLabel: string;
  };
};

/** Display only: the vendor page where a `paste_url` endpoint is registered, and the steps to register it. */
interface WebhookSetup {
  url: `https://${string}`;
  steps: ReadonlyArray<string>;
  /** The vendor generates this key; setup must import it instead of displaying Frink’s random key. */
  secret?: { label: string; instructions: string };
}

/** Every provider has the same shape: no upstream account or credential, just an external system
 * the user points at a secret inbound URL on the shared receiver — so no row carries an auth spec. */
export interface Provider {
  id: string;
  display_name: string;
  icon: string;
  /** One line. The directory row's subtitle and the detail page's tagline — never prose. */
  description: string;
  /** The detail page's paragraph: what this plugin is FOR. Never an inventory of its triggers or tools. */
  long_description: string;
  category: ProviderCategory;
  status: 'available' | 'coming_soon';
  enabled_when?: ReadonlyArray<LaunchFlagKey>;
  /** Allowed origin for links from signed webhook content. */
  web_domain?: `https://${string}`;
  events: ReadonlyArray<EventSpec>;
  filter_fields: ReadonlyArray<FilterField>;
  subscription: TriggerSubscription;
  registrar?: TriggerRegistrar;
  webhook_setup?: WebhookSetup;
  /** Vendor-issued verification token requires an owner-confirmed setup step. */
  webhook_verification?: 'notion';
  /** How the shared receiver authenticates the delivery and finds its id; required on every row. */
  webhook_payload: WebhookPayloadSpec;
  /** `generic` = no vendor code at all; anything else names a curated extractor for the body. */
  payload_extractor: PayloadExtractorId;
}

/** A row `pasteUrlExtractor` reads from `webhook_payload` alone — no vendor file behind it. */
export type PayloadDrivenWebhookProvider = Provider & { payload_extractor: 'generic' };

/** A raw vendor webhook body — what `trigger-samples/` carries one of per catalog event. */
export type TriggerSample = { readonly [key: string]: JsonValue };

/** Raw vendor bodies keyed provider id then event id; `trigger-samples/` is the one instance. */
export type TriggerSampleCatalog = Readonly<
  Record<string, Readonly<Record<string, TriggerSample>>>
>;
