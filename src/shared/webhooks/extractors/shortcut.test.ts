import { describe, expect, it } from 'vitest';
import storyAssigned from './__fixtures__/shortcut/story.assigned.json';
import storyCreated from './__fixtures__/shortcut/story.created.json';
import storyMoved from './__fixtures__/shortcut/story.moved.json';
import storyUnassigned from './__fixtures__/shortcut/story.unassigned.json';
import storyUpdated from './__fixtures__/shortcut/story.updated.json';
import { shortcutExtractor } from './shortcut';

const fixtures = [
  { name: 'story.created', payload: storyCreated },
  { name: 'story.updated', payload: storyUpdated },
  { name: 'story.assigned', payload: storyAssigned },
  // owner removed (unassign) — must map to null (no second story_assigned).
  { name: 'story.unassigned', payload: storyUnassigned },
  { name: 'story.moved', payload: storyMoved },
] as const;

describe('shortcutExtractor.detectEventType', () => {
  for (const { name, payload } of fixtures) {
    it(`maps ${name} to a stable event type`, () => {
      expect(shortcutExtractor.detectEventType(payload)).toMatchSnapshot();
    });
  }
});

describe('shortcutExtractor.buildEventData', () => {
  for (const { name, payload } of fixtures) {
    const eventType = shortcutExtractor.detectEventType(payload);
    if (eventType === null) {
      // story.updated (description-only change) is intentionally a null-event-type fixture
      // — original handler bails before buildEventData. Snapshotting build output here would
      // record an invalid state that has no counterpart in the original code path.
      continue;
    }
    it(`builds event data for ${name}`, async () => {
      const data = await shortcutExtractor.buildEventData(payload, {
        integrationId: 'test',
        userId: 'test',
        eventType,
        externalUserId: 'me_id',
      });
      expect(data).toMatchSnapshot();
    });
  }

  // The "me" assignee filter compares these ids with the account's stored vendor id. A create
  // action carries the story's own owners; only an update reports them as a change.
  it("carries a new story's owner ids for the assignee filter", async () => {
    const data = await shortcutExtractor.buildEventData(storyCreated, {
      integrationId: 'test',
      userId: 'test',
      eventType: 'story_created',
      externalUserId: 'me_id',
    });
    expect(data.owner_ids).toEqual(['6126f7a4-d1e2-4b3a-9c2f-7d8e1c4b5a90']);
    expect(data.ownerIds).toEqual(data.owner_ids);
  });
});

// Owner-change direction: only an ADD is an assignment. A reassign reaches us as
// two deliveries (remove-old, add-new) with distinct payload.ids, so the remove
// half must NOT also fire story_assigned (that was the double-task bug). Covers
// the single-delivery {adds,removes} reassign and the {old,new} shape too.
describe('shortcutExtractor.detectEventType — owner_ids direction', () => {
  const ownerUpdate = (owner_ids: unknown) => ({
    actions: [{ entity_type: 'story', action: 'update', changes: { owner_ids } }],
  });

  it('single-delivery reassign ({adds,removes} both set) → story_assigned once', () => {
    expect(shortcutExtractor.detectEventType(ownerUpdate({ adds: ['b'], removes: ['a'] }))).toBe(
      'story_assigned',
    );
  });

  it('{old,new} that nets an add → story_assigned', () => {
    expect(shortcutExtractor.detectEventType(ownerUpdate({ old: ['a'], new: ['a', 'b'] }))).toBe(
      'story_assigned',
    );
  });

  it('{old,new} that only removes → null', () => {
    expect(
      shortcutExtractor.detectEventType(ownerUpdate({ old: ['a', 'b'], new: ['a'] })),
    ).toBeNull();
  });

  it('{old,new} removing the last owner ({new:[]}) → null', () => {
    expect(shortcutExtractor.detectEventType(ownerUpdate({ old: ['a'], new: [] }))).toBeNull();
  });
});
