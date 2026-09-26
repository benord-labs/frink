/**
 * Snapshots `detectEventType` → `buildEventData` for every production-shape fixture, pinning the
 * `WebhookEventData` contract the machine's `src/shared/lib/webhook-match.ts` matches against.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROVIDERS } from '../../integrations/providers';
import { extractors } from '.';
import { pasteUrlExtractor, webhookOnlyProvider } from './generic';
import type { ExtractorContext, PayloadExtractor } from './types';

const FIXTURES_DIR = path.join(__dirname, '__fixtures__');
const USER_ID = 'user-e2e';
const INTEGRATION_ID = 'integration-e2e';

function loadFixture(provider: string, name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, provider, name), 'utf8'));
}

type Case = {
  provider: 'shortcut' | 'linear' | 'posthog' | 'cloudflare' | 'vercel' | 'sentry';
  fixture: string;
  extractorPayload: (raw: unknown) => unknown;
  detectArg?: (raw: unknown) => Parameters<typeof extractors.shortcut.detectEventType>[1];
  buildCtxExtras?: (raw: unknown) => Record<string, unknown>;
};

const cases: Case[] = [
  ...([
    'story.created.json',
    'story.assigned.json',
    'story.unassigned.json',
    'story.moved.json',
    'story.updated.json',
  ].map((fixture): Case => ({
    provider: 'shortcut',
    fixture,
    extractorPayload: (raw) => raw,
  })) as Case[]),

  ...[
    'issue_created.json',
    'issue_assigned.json',
    'issue_unassigned.json',
    'issue_status_changed.json',
    'comment_created.json',
    'issue_update_noop.json',
  ].map((fixture): Case => ({ provider: 'linear', fixture, extractorPayload: (raw) => raw })),

  // PostHog — the data-driven row over the HTTP Webhook destination's default body.
  ...['event.json', 'exception.json'].map((fixture): Case => ({
    provider: 'posthog',
    fixture,
    extractorPayload: (raw) => raw,
  })),

  // One pasted-URL vendor per body shape the shared receiver reads: a flat event name, a dotted one
  // behind a delivery id, and a row whose body names only the action.
  ...(
    [
      ['cloudflare', 'health_check.json'],
      ['vercel', 'deployment_error.json'],
      ['sentry', 'issue_resolved.json'],
    ] as const
  ).map(([provider, fixture]): Case => ({ provider, fixture, extractorPayload: (raw) => raw })),
];

/** A webhook-only row drives the shared extractor; every other provider has a curated one. */
const curated: Partial<Record<Case['provider'], PayloadExtractor>> = extractors;
function extractorFor(provider: Case['provider']): PayloadExtractor {
  const row = webhookOnlyProvider(provider);
  const extractor = row ? pasteUrlExtractor(row) : curated[provider];
  if (!extractor) throw new Error(`No extractor for ${provider}`);
  return extractor;
}

describe('e2e parity: extractors → normalized WebhookEventData', () => {
  for (const c of cases) {
    it(`${c.provider}/${c.fixture}`, async () => {
      const raw = loadFixture(c.provider, c.fixture);
      const extractor = extractorFor(c.provider);
      const detectArg = c.detectArg ? c.detectArg(raw) : undefined;
      const eventType = extractor.detectEventType(c.extractorPayload(raw), detectArg);

      if (eventType === null) {
        // Some fixtures intentionally don't map to a known event type — snapshot
        // the null result so the extractor's gating stays pinned.
        expect({ eventType: null, eventData: null }).toMatchSnapshot();
        return;
      }

      const ctx: ExtractorContext = {
        integrationId: INTEGRATION_ID,
        userId: USER_ID,
        eventType,
        externalUserId: 'external-user-e2e',
        ...(c.buildCtxExtras ? c.buildCtxExtras(raw) : {}),
      };

      const eventData = await extractor.buildEventData(c.extractorPayload(raw), ctx);
      expect({ eventType, eventData }).toMatchSnapshot();

      // A filter id IS the event-data key the machine-side matcher reads: every filter a
      // template offers must name a key this extractor emitted for the event.
      const offered =
        PROVIDERS.find((p) => p.id === c.provider)?.events.find((e) => e.id === eventType)
          ?.filter_field_ids ?? [];
      for (const id of offered) {
        expect(Object.keys(eventData), `${c.provider}/${eventType} filter ${id}`).toContain(id);
      }
    });
  }

  it('every template offers only filter fields its provider declares', () => {
    for (const provider of PROVIDERS) {
      const declared = provider.filter_fields.map((field) => field.id);
      for (const event of provider.events) {
        for (const id of event.filter_field_ids ?? []) {
          expect(declared, `${provider.id}/${event.id} offers ${id}`).toContain(id);
        }
      }
    }
  });
});
