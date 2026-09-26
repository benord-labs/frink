/**
 * Single display model for a flow trigger, built from the RAW provider webhook body
 * (`trigger.fullContent`). Consumed by all three surfaces — the Work Queue card, the in-chat
 * trigger bubble, and the "View original content" dialog — so they can never diverge again.
 *
 * Hybrid: a per-provider builder reads the rich fields a given webhook actually carries
 * (Shortcut resolves `references[]` + a "what changed" diff); any provider without a builder
 * falls back to the declarative {@link TRIGGER_FIELD_ALIASES} map. No REST enrichment — we render
 * what arrived, well, and never a half-empty card.
 *
 * (the cloud prompt builder consumes it transitively).
 */

import { getProviderById } from '../integrations/selectors';
import { TRIGGER_FIELD_ALIASES } from '../integrations/trigger-field-aliases';
import { isAllowedShellOpenExternalUrl } from '../shell-external-url';
import type { TriggerContext, TriggerSource } from '../types/trigger-context';
import { extractEmailDisplayName } from './email-display-name';
import { resolveAlias } from './provider-trigger-aliases';
import { formatTriggerTimestamp } from './trigger-timestamp';

export type TriggerSummaryTone = 'primary' | 'green' | 'amber' | 'neutral';

type TriggerSummaryField = {
  label: string;
  value: string | number;
  tone?: TriggerSummaryTone;
  href?: string;
};

/** A single "what changed" entry (e.g. workflow state old → new). */
export type TriggerSummaryChange = { label: string; from?: string; to?: string };

export type TriggerSummary = {
  source: TriggerSource;
  /** Provider display name ("Shortcut") — falls back to the source id for unknown providers. */
  provider: string;
  title?: string;
  subtitle?: string;
  /** Scalar, non-empty rows only — never `[object Object]`, never fabricated "None"/"unknown". */
  fields: TriggerSummaryField[];
  description?: string;
  changes?: TriggerSummaryChange[];
  /** Primary external link, scheme- AND origin-validated. */
  link?: string;
  autoStart: boolean;
  /** Legacy rule label (absent for flow-as-trigger). */
  triggerRuleName?: string;
};

// ── value gates ─────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** Display-safe scalar. Objects/arrays are rejected so a field never renders `[object Object]`. */
function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/**
 * Push a field ONLY when the value is a non-empty scalar. Drops `null`/`undefined`/`''`, but keeps a
 * legitimate `0`/`false` — never a blanket falsy check.
 */
function pushField(
  out: TriggerSummaryField[],
  label: string,
  value: unknown,
  opts?: { tone?: TriggerSummaryTone; href?: string },
): void {
  if (!isScalar(value)) return;
  if (typeof value === 'string' && value.trim() === '') return;
  out.push({ label, value: typeof value === 'boolean' ? String(value) : value, ...opts });
}

function truncate(s: string, max = 140): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Only providers declaring a trusted web origin can link signed event content. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- rawUrl arrives unvalidated from a provider webhook payload; validating it is precisely what this function does.
function resolveSafeLink(rawUrl: unknown, source: string): string | undefined {
  if (typeof rawUrl !== 'string' || !isAllowedShellOpenExternalUrl(rawUrl)) return undefined;
  const provider = getProviderById(source);
  const webDomain = provider?.web_domain;
  if (!webDomain) return undefined;
  try {
    return new URL(rawUrl).origin === new URL(webDomain).origin ? rawUrl : undefined;
  } catch {
    return undefined;
  }
}

// ── Shortcut reference helpers (raw webhook body) ─────────────────────────────

type ShortcutRef = { id?: unknown; entity_type?: unknown; name?: unknown };

function shortcutRefs(raw: Record<string, unknown>): ShortcutRef[] {
  return Array.isArray(raw.references) ? (raw.references as ShortcutRef[]) : [];
}

function refNameById(refs: ShortcutRef[], id: unknown): string | undefined {
  if (id == null) return undefined;
  const r = refs.find((x) => x.id === id);
  return typeof r?.name === 'string' ? r.name : undefined;
}

function refNamesByIds(refs: ShortcutRef[], ids: unknown): string | undefined {
  if (!Array.isArray(ids)) return undefined;
  const names = ids.map((id) => refNameById(refs, id)).filter((n): n is string => Boolean(n));
  return names.length ? names.join(', ') : undefined;
}

// ── per-provider builders ────────────────────────────────────────────────────

type SummaryPartial = Pick<
  TriggerSummary,
  'title' | 'subtitle' | 'fields' | 'description' | 'changes' | 'link'
>;
type SummaryBuilder = (raw: Record<string, unknown>, ctx: TriggerContext) => SummaryPartial;

function buildShortcutSummary(raw: Record<string, unknown>): SummaryPartial {
  const actions = Array.isArray(raw.actions) ? (raw.actions as Record<string, unknown>[]) : [];
  const story = actions.find((a) => a.entity_type === 'story') ?? actions[0] ?? {};
  const refs = shortcutRefs(raw);
  const fields: TriggerSummaryField[] = [];
  const link = resolveSafeLink(story.app_url, 'shortcut');

  const changesObj = isRecord(story.changes) ? story.changes : undefined;
  const stateId = changesObj?.workflow_state_id
    ? (changesObj.workflow_state_id as Record<string, unknown>).new
    : story.workflow_state_id;
  const stateName = refNameById(refs, stateId);
  const storyId = typeof raw.primary_id === 'number' ? raw.primary_id : undefined;

  pushField(fields, 'Story ID', storyId != null ? `#${storyId}` : undefined, {
    tone: 'primary',
    href: link,
  });
  pushField(fields, 'Type', story.story_type, { tone: 'neutral' });
  pushField(fields, 'State', stateName, { tone: 'green' });
  pushField(fields, 'Project', refNameById(refs, story.project_id), { tone: 'amber' });
  pushField(fields, 'Epic', refNameById(refs, story.epic_id));
  pushField(fields, 'Labels', refNamesByIds(refs, story.label_ids));
  pushField(fields, 'Owners', refNamesByIds(refs, story.owner_ids));
  pushField(fields, 'Estimate', typeof story.estimate === 'number' ? story.estimate : undefined);

  const changes: TriggerSummaryChange[] = [];
  if (changesObj) {
    const ws = isRecord(changesObj.workflow_state_id) ? changesObj.workflow_state_id : undefined;
    if (ws) {
      changes.push({
        label: 'State',
        from: refNameById(refs, ws.old),
        to: refNameById(refs, ws.new),
      });
    }
    const owners = isRecord(changesObj.owner_ids) ? changesObj.owner_ids : undefined;
    if (owners) {
      const added = refNamesByIds(refs, owners.adds);
      const removed = refNamesByIds(refs, owners.removes);
      if (added) changes.push({ label: 'Owners added', to: added });
      if (removed) changes.push({ label: 'Owners removed', from: removed });
    }
    const est = isRecord(changesObj.estimate) ? changesObj.estimate : undefined;
    if (est && (isScalar(est.old) || isScalar(est.new))) {
      changes.push({ label: 'Estimate', from: scalarStr(est.old), to: scalarStr(est.new) });
    }
  }

  const subtitle = [
    storyId != null ? `#${storyId}` : undefined,
    stateName,
    typeof story.story_type === 'string' ? story.story_type : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    title: typeof story.name === 'string' ? story.name : undefined,
    subtitle: subtitle || undefined,
    fields,
    description: typeof story.description === 'string' ? story.description : undefined,
    changes: changes.length ? changes : undefined,
    link,
  };
}

function buildGithubSummary(raw: Record<string, unknown>): SummaryPartial {
  const item = (
    isRecord(raw.issue) ? raw.issue : isRecord(raw.pull_request) ? raw.pull_request : {}
  ) as Record<string, unknown>;
  const link = resolveSafeLink(item.html_url, 'github');
  const fields: TriggerSummaryField[] = [];
  pushField(fields, 'Number', typeof item.number === 'number' ? item.number : undefined, {
    tone: 'primary',
    href: link,
  });
  pushField(fields, 'State', item.state, { tone: 'green' });
  const labels = Array.isArray(item.labels)
    ? (item.labels as Record<string, unknown>[])
        .map((l) => (typeof l.name === 'string' ? l.name : undefined))
        .filter((n): n is string => Boolean(n))
    : [];
  if (labels.length) pushField(fields, 'Labels', labels.join(', '));
  pushField(fields, 'Author', isRecord(raw.sender) ? raw.sender.login : undefined);
  pushField(fields, 'Repository', isRecord(raw.repository) ? raw.repository.full_name : undefined);

  return {
    title: typeof item.title === 'string' ? item.title : undefined,
    subtitle: typeof raw.action === 'string' ? raw.action : undefined,
    fields,
    description: typeof item.body === 'string' ? item.body : undefined,
    link,
  };
}

function buildGmailSummary(raw: Record<string, unknown>): SummaryPartial {
  const fields: TriggerSummaryField[] = [];
  pushField(
    fields,
    'From',
    extractEmailDisplayName(typeof raw.from === 'string' ? raw.from : undefined),
  );
  pushField(fields, 'To', typeof raw.to === 'string' ? raw.to : undefined);
  return {
    title: typeof raw.subject === 'string' ? raw.subject : undefined,
    subtitle: typeof raw.snippet === 'string' ? truncate(raw.snippet) : undefined,
    fields,
    // Body deliberately omitted — the rich body lives in EmailTriggerContentDialog.
  };
}

function buildSlackSummary(raw: Record<string, unknown>): SummaryPartial {
  const event = isRecord(raw.event) ? raw.event : {};
  const fields: TriggerSummaryField[] = [];
  pushField(fields, 'User', event.user);
  pushField(fields, 'Channel', event.channel);
  return {
    title: typeof event.text === 'string' ? truncate(event.text) : undefined,
    subtitle: typeof event.type === 'string' ? event.type : undefined,
    fields,
  };
}

/** Alias names that should populate the card title rather than a field row. */
const TITLE_ALIAS = /(^|\.)(title|subject|name|text)$/;

/** Alias names that should become the card's link rather than a field row. */
const LINK_ALIAS = /(^|\.)url$/;

/** Declarative fallback for any provider with an alias map but no bespoke builder. */
function buildGenericSummary(raw: Record<string, unknown>, ctx: TriggerContext): SummaryPartial {
  const aliases = TRIGGER_FIELD_ALIASES[ctx.source] ?? [];
  const fields: TriggerSummaryField[] = [];
  let title: string | undefined;
  let link: string | undefined;
  for (const a of aliases) {
    const value = resolveAlias(raw, a.path);
    if (!title && TITLE_ALIAS.test(a.alias) && typeof value === 'string') {
      title = value;
      continue;
    }
    if (!link && LINK_ALIAS.test(a.alias)) {
      // Same origin check the bespoke builders use — a raw URL is never rendered
      // as a field, so an off-domain one is dropped rather than shown unlinked.
      link = resolveSafeLink(value, ctx.source);
      continue;
    }
    pushField(fields, a.label, value);
  }
  return { title, subtitle: ctx.eventType || undefined, fields, link };
}

const PROVIDER_BUILDERS: Partial<Record<TriggerSource, SummaryBuilder>> = {
  shortcut: buildShortcutSummary,
  github: buildGithubSummary,
  gmail: buildGmailSummary,
  slack: buildSlackSummary,
};

// ── entry point ───────────────────────────────────────────────────────────────

export function buildTriggerSummary(ctx: TriggerContext): TriggerSummary {
  const raw = isRecord(ctx.fullContent) ? ctx.fullContent : {};
  const builder = PROVIDER_BUILDERS[ctx.source];
  const partial = builder ? builder(raw, ctx) : buildGenericSummary(raw, ctx);

  // Envelope rows appended consistently for every provider (absent ones drop via pushField).
  const fields = [...partial.fields];
  pushField(fields, 'Event', ctx.eventType);
  pushField(fields, 'Triggered by', ctx.triggeredBy?.name);
  pushField(fields, 'Triggered at', formatTriggerTimestamp(ctx.timestamp));
  pushField(fields, 'Rule', ctx.triggerRuleName);
  pushField(fields, 'Account', ctx.sourceAccountName);

  return {
    source: ctx.source,
    provider: getProviderById(ctx.source)?.display_name ?? ctx.source,
    title: partial.title,
    subtitle: partial.subtitle,
    fields,
    description: partial.description,
    changes: partial.changes,
    link: partial.link,
    autoStart: ctx.autoStart ?? false,
    triggerRuleName: ctx.triggerRuleName || undefined,
  };
}

/**
 * Normalize a parsed chat-bubble marker payload into a `TriggerSummary`. Accepts the current shape
 * (has `fields[]`) AND a legacy `TriggerBubbleData` blob from old chat history — mapping its known
 * fields (storyTitle/subject→title, storyType/status/project/from→fields) so old bubbles never render
 * empty. Returns null for non-objects.
 */
export function coerceTriggerSummary(parsed: unknown): TriggerSummary | null {
  if (!isRecord(parsed)) return null;
  const p = parsed;
  const hasNewShape = Array.isArray(p.fields);
  // Defense-in-depth: re-scrub every href on parse (the only writer already validates, but the
  // marker is persisted chat data — never let a `javascript:`/unvalidated URL reach an <a href>).
  const safeHref = (u: unknown): string | undefined =>
    typeof u === 'string' && isAllowedShellOpenExternalUrl(u) ? u : undefined;
  const fields: TriggerSummaryField[] = hasNewShape
    ? (p.fields as TriggerSummaryField[]).map((f) => ({ ...f, href: safeHref(f.href) }))
    : [];
  if (!hasNewShape) {
    pushField(fields, 'Type', p.storyType);
    pushField(fields, 'Status', p.status);
    pushField(fields, 'Project', p.projectName);
    pushField(fields, 'From', p.from);
  }
  const sourceVal = typeof p.source === 'string' ? p.source : 'generic_webhook';
  return {
    source: sourceVal as TriggerSource,
    provider:
      typeof p.provider === 'string'
        ? p.provider
        : (getProviderById(sourceVal)?.display_name ?? sourceVal),
    title: firstString(p.title, p.storyTitle, p.subject),
    subtitle: typeof p.subtitle === 'string' ? p.subtitle : undefined,
    fields,
    description: firstString(p.description, p.fullDetails),
    changes: Array.isArray(p.changes) ? (p.changes as TriggerSummaryChange[]) : undefined,
    link: safeHref(p.link),
    autoStart: p.autoStart === true,
    triggerRuleName:
      typeof p.triggerRuleName === 'string' && p.triggerRuleName ? p.triggerRuleName : undefined,
  };
}

// ── tiny formatters ─────────────────────────────────────────────────────────

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === 'string' && v.trim() !== '') return v;
  return undefined;
}

function scalarStr(v: unknown): string | undefined {
  return isScalar(v) ? String(v) : undefined;
}
