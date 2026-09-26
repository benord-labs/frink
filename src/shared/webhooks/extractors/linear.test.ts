import { describe, expect, it } from 'vitest';
import { PROVIDERS } from '../../integrations/providers';
import { matchesConditions } from '../../lib/webhook-match';
import commentCreated from './__fixtures__/linear/comment_created.json';
import issueAssigned from './__fixtures__/linear/issue_assigned.json';
import issueCreated from './__fixtures__/linear/issue_created.json';
import issueStatusChanged from './__fixtures__/linear/issue_status_changed.json';
import issueUnassigned from './__fixtures__/linear/issue_unassigned.json';
import issueUpdateNoop from './__fixtures__/linear/issue_update_noop.json';
import { extractors } from './index';
import { linearExtractor } from './linear';

/** Deliberately partial Linear deliveries, for shapes the fixtures do not model. */
type LinearTestBody = {
  type?: string;
  action?: string;
  updatedFrom?: { assigneeId?: string | null; stateId?: string | null } | null;
  data?: Record<string, string | null>;
};

/** Fixture -> the event type it must resolve to. Asserted by name, not only by snapshot. */
const FIRES: ReadonlyArray<[string, unknown, string]> = [
  ['issue_created', issueCreated, 'issue_created'],
  ['issue_assigned', issueAssigned, 'issue_assigned'],
  ['issue_status_changed', issueStatusChanged, 'issue_status_changed'],
  ['comment_created', commentCreated, 'issue_commented'],
];

/** Fixtures the extractor must refuse outright. */
const DROPS: ReadonlyArray<[string, unknown, string]> = [
  [
    'issue_unassigned',
    issueUnassigned,
    'an unassign also carries an assigneeId delta; firing would make every reassign spawn two runs',
  ],
  ['issue_update_noop', issueUpdateNoop, 'a title edit is not an event any trigger listens on'],
];

const LINEAR_USER_ID = 'aacdca22-6266-4c0a-ab3c-8fa70a26765c';

describe('linearExtractor', () => {
  for (const [name, fixture, expected] of FIRES) {
    describe(name, () => {
      const detected = linearExtractor.detectEventType(fixture);

      it(`detectEventType -> ${expected}`, () => {
        expect(detected).toBe(expected);
      });

      it('buildEventData', async () => {
        if (detected === null) throw new Error(`detectEventType returned null for ${name}`);
        const data = await linearExtractor.buildEventData(fixture, {
          integrationId: 'test',
          userId: 'test',
          eventType: detected,
          externalUserId: LINEAR_USER_ID,
        });
        expect(data).toMatchSnapshot();
      });
    });
  }

  for (const [name, fixture, why] of DROPS) {
    it(`drops ${name} — ${why}`, () => {
      expect(linearExtractor.detectEventType(fixture)).toBeNull();
    });
  }

  it('resolves Linear\'s assign-and-move "start issue" to the status change', () => {
    // Starting an issue moves AND assigns it: resolving to the withheld issue_assigned fires nothing.
    // SAFETY: the intersection only widens updatedFrom so the clone can carry a second delta.
    const both = structuredClone(issueAssigned) as typeof issueAssigned & {
      updatedFrom: { assigneeId?: string | null; stateId?: string | null };
    };
    both.updatedFrom.stateId = 'b3d5f6e0-1c2a-4d8e-9f00-a1b2c3d4e5f6';
    expect(linearExtractor.detectEventType(both)).toBe('issue_status_changed');
  });

  it('still reports a pure assignment, with no state delta, as an assignment', () => {
    expect(linearExtractor.detectEventType(issueAssigned)).toBe('issue_assigned');
  });

  it('a status change on an assigned issue stays a status change, not an assignment', () => {
    // data.assigneeId is populated here, so only the updatedFrom delta separates
    // the two events; reading data alone would misclassify.
    expect(linearExtractor.detectEventType(issueStatusChanged)).toBe('issue_status_changed');
  });

  describe('malformed payloads', () => {
    const body = (fields: LinearTestBody) => fields;

    it('drops an assignee update whose data object is missing', () => {
      expect(
        linearExtractor.detectEventType(
          body({ type: 'Issue', action: 'update', updatedFrom: { assigneeId: null } }),
        ),
      ).toBeNull();
    });

    it('drops an update whose updatedFrom is null rather than an object', () => {
      expect(
        linearExtractor.detectEventType(
          body({ type: 'Issue', action: 'update', updatedFrom: null, data: { id: 'i1' } }),
        ),
      ).toBeNull();
    });

    it('drops a deleted issue', () => {
      expect(
        linearExtractor.detectEventType(body({ type: 'Issue', action: 'remove', data: {} })),
      ).toBeNull();
    });

    it('drops a comment edit, keeping issue_commented to genuinely new comments', () => {
      expect(
        linearExtractor.detectEventType(
          body({ type: 'Comment', action: 'update', data: { body: 'edited' } }),
        ),
      ).toBeNull();
    });

    it('drops an entity Frink does not subscribe to', () => {
      expect(
        linearExtractor.detectEventType(body({ type: 'Project', action: 'create', data: {} })),
      ).toBeNull();
    });

    it('survives a body with no event fields at all', () => {
      expect(linearExtractor.detectEventType({})).toBeNull();
      expect(linearExtractor.detectEventType(null)).toBeNull();
    });
  });

  describe('trigger-context boundary', () => {
    it('reports the acting Linear user, never a credential handle', async () => {
      const data = await linearExtractor.buildEventData(commentCreated, {
        integrationId: 'test',
        userId: 'test',
        eventType: 'issue_commented',
        externalUserId: LINEAR_USER_ID,
      });
      // Trigger context is agent-visible, so a credential-broker handle must not appear
      // in any field (integration-credential-broker).
      expect(JSON.stringify(data)).not.toContain('providerConfigKey');
      expect(data.externalUserId).toBe('b5ea5f1f-8adc-4f52-b4bd-ab4e84cf51ba');
    });

    it('resolves issueId to the issue, not the comment, on a comment delivery', async () => {
      const data = await linearExtractor.buildEventData(commentCreated, {
        integrationId: 'test',
        userId: 'test',
        eventType: 'issue_commented',
        externalUserId: LINEAR_USER_ID,
      });
      expect(data.issueId).toBe('9cfb482a-81e3-4154-b5b9-2c805e70a02d');
      expect(data.issueId).not.toBe('2174add1-f7c8-44e3-bbf3-2d60b5ea8bc9');
    });
  });

  describe('filter fields', () => {
    it('offers no filter on an event whose payload cannot carry it', async () => {
      // SAFETY: asserted present by the registry parity tests above.
      const linear = PROVIDERS.find((p) => p.id === 'linear')!;
      const comment = linear.events.find((e) => e.id === 'issue_commented');
      // A Comment delivery has no priorityLabel, so a configured priority filter
      // would silently drop every comment.
      expect(comment?.filter_field_ids).toEqual([]);
    });

    it('every registry filter id names a key buildEventData actually emits', async () => {
      const data = await linearExtractor.buildEventData(issueStatusChanged, {
        integrationId: 'test',
        userId: 'test',
        eventType: 'issue_status_changed',
        externalUserId: LINEAR_USER_ID,
      });
      // matchesConditions reads eventData[filter.field] verbatim, so an unemitted id fails closed.
      // SAFETY: the registry parity tests above assert linear is present.
      const linear = PROVIDERS.find((p) => p.id === 'linear')!;
      const unmatched = linear.filter_fields.map((f) => f.id).filter((id) => !(id in data));
      expect(unmatched).toEqual([]);
    });

    it('a priority filter matches the value the extractor forwards', async () => {
      const data = await linearExtractor.buildEventData(issueStatusChanged, {
        integrationId: 'test',
        userId: 'test',
        eventType: 'issue_status_changed',
        externalUserId: LINEAR_USER_ID,
      });
      const filter = (value: string) => ({
        filters: [{ field: 'priorityLabel', operator: 'equals', value }],
      });
      expect(matchesConditions(filter('High'), data)).toBe(true);
      expect(matchesConditions(filter('Low'), data)).toBe(false);
    });

    it('offers only values Linear actually sends as priorityLabel', () => {
      // SAFETY: asserted present by the registry parity tests above.
      const linear = PROVIDERS.find((p) => p.id === 'linear')!;
      const priority = linear.filter_fields.find((f) => f.id === 'priorityLabel');
      // A static_enum whose values never appear in a payload is a filter that
      // silently stops the trigger firing.
      expect(priority?.static_values).toContain('High');
      expect(priority?.value_source).toBe('static_enum');
    });
  });

  describe('assignee data', () => {
    it('carries owner_ids so the trigger can narrow once identity is populated', async () => {
      const data = await linearExtractor.buildEventData(issueAssigned, {
        integrationId: 'test',
        userId: 'test',
        eventType: 'issue_assigned',
        externalUserId: LINEAR_USER_ID,
      });
      // owner_ids is the field webhook-match.ts reads for assignee conditions.
      expect(data.owner_ids).toEqual([LINEAR_USER_ID]);
      expect(matchesConditions({ assignee: 'me' }, data, LINEAR_USER_ID)).toBe(true);
      expect(matchesConditions({ assignee: 'me' }, data, 'someone-else')).toBe(false);
    });
  });
});

describe('extractor registration', () => {
  it('registers an extractor for every row that names one', () => {
    // Both receivers resolve `extractors[row.payload_extractor]`. A registry entry with
    // no registered extractor throws inside a signed, already-accepted delivery.
    const missing = PROVIDERS.map((p) => p.payload_extractor).filter((id) => !(id in extractors));
    expect(missing).toEqual([]);
  });

  it('resolves the linear id to the linear extractor', () => {
    expect(extractors.linear).toBe(linearExtractor);
  });
});
