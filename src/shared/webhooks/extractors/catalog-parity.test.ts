import { describe, expect, it } from 'vitest';
import { PROVIDERS } from '../../integrations/providers';
import { isPayloadDrivenWebhookProvider } from '../../integrations/selectors';
import { TRIGGER_SAMPLES } from '../../integrations/trigger-samples';
import type { Provider } from '../../integrations/types';
import { extractorFor, extractors } from '.';

/**
 * The catalog and these extractors are two vocabularies with no import path between them, so drift
 * is invisible both ways. Reachability and the vendor-subscription limit: provider-trigger-catalog-shape.
 */

/**
 * What each `detectEventType` can return. Hand-maintained: return values are not introspectable
 * at runtime, so adding a branch means adding its id here.
 */
const EMITTED_BY_EXTRACTOR = {
  shortcut: ['story_created', 'story_assigned', 'story_moved'],
  linear: ['issue_created', 'issue_assigned', 'issue_status_changed', 'issue_commented'],
} satisfies ProviderEventIds;

/**
 * Emitted on purpose, offered nowhere on purpose: narrowing `issue_assigned` to "me" needs
 * `user_integrations.external_user_id`, which nothing populates today (sc-2251).
 */
const WITHHELD_PENDING_IDENTITY = {
  linear: ['issue_assigned'],
} satisfies ProviderEventIds;

/** Provider ids are plain strings on `FirstClassProvider`, so the maps are keyed by string. */
type ProviderEventIds = Readonly<Record<string, ReadonlyArray<string>>>;

function idsFor(map: ProviderEventIds, providerId: string): ReadonlyArray<string> {
  return map[providerId] ?? [];
}

/** Rows with a curated extractor; a row with no vendor code carries its vocabulary as data. */
function curatedProviders(): ReadonlyArray<Provider> {
  return PROVIDERS.filter((provider) => !isPayloadDrivenWebhookProvider(provider));
}

describe('trigger catalog <-> extractor parity', () => {
  it('covers every curated provider, so a new one cannot skip the check', () => {
    const uncovered = curatedProviders()
      .map((provider) => provider.id)
      .filter((id) => !(id in EMITTED_BY_EXTRACTOR));
    expect(uncovered).toEqual([]);
  });

  for (const provider of curatedProviders()) {
    const emitted = idsFor(EMITTED_BY_EXTRACTOR, provider.id);
    const withheld = idsFor(WITHHELD_PENDING_IDENTITY, provider.id);
    const offered = provider.events.map((event) => event.id);

    describe(provider.id, () => {
      it('offers no trigger the extractor cannot emit', () => {
        expect(offered.filter((id) => !emitted.includes(id))).toEqual([]);
      });

      it('offers every event the extractor emits, or withholds it deliberately', () => {
        expect(emitted.filter((id) => !offered.includes(id) && !withheld.includes(id))).toEqual([]);
      });

      it('does not both withhold and offer the same event', () => {
        // Fails loudly if a withheld event is later offered, rather than letting the
        // allowlist silently grow past its rationale.
        expect(withheld.filter((id) => offered.includes(id))).toEqual([]);
      });
    });
  }
});

describe('rows with no vendor code drive the shared extractor', () => {
  for (const provider of PROVIDERS.filter(isPayloadDrivenWebhookProvider)) {
    describe(provider.id, () => {
      it('resolves to a registered extractor', () => {
        expect(extractors[provider.payload_extractor]).toBeDefined();
      });

      it('names at most one catch-all intent, and every other intent names its vendor events', () => {
        const catchAll = provider.events.filter((event) => event.vendor_events === undefined);
        expect(catchAll.length).toBeLessThanOrEqual(1);
        const named = provider.events.filter((event) => event.vendor_events !== undefined);
        expect(named.every((event) => (event.vendor_events?.length ?? 0) > 0)).toBe(true);
        // Naming a vendor event is meaningless when nothing reads the event name from the body.
        if (named.length > 0) expect(provider.webhook_payload.event_type_path).toBeDefined();
      });

      // An assignee choice the row cannot back never fires: "anyone" needs ids, "me" needs a match.
      it('offers an assignee choice only where the row says where its people are', () => {
        const flagged = provider.events.filter((event) => event.assignee === true);
        if (flagged.length > 0) expect(provider.webhook_payload.owner_ids).toBeDefined();
        if (provider.webhook_payload.owner_ids) expect(flagged.length).toBeGreaterThan(0);
      });

      it('flattens every offered filter from a declared path, so the matcher can read it', () => {
        const offered = new Set(provider.events.flatMap((event) => event.filter_field_ids));
        for (const field of provider.filter_fields.filter((f) => offered.has(f.id))) {
          expect(field.path, `${provider.id} filter ${field.id}`).toBeDefined();
        }
      });
    });
  }
});

describe('every offered trigger has a sample that resolves back to it', () => {
  for (const provider of PROVIDERS) {
    describe(provider.id, () => {
      for (const event of provider.events) {
        it(event.id, () => {
          const sample = TRIGGER_SAMPLES[provider.id]?.[event.id];
          expect(sample, `${provider.id}/${event.id} has no sample`).toBeDefined();
          if (!sample) return;
          const resolved = extractorFor(provider).detectEventType(sample);
          expect(resolved).toBe(event.id);
        });
      }
    });
  }
});
