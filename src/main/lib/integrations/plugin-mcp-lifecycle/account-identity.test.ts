import { describe, expect, it } from 'vitest';
import { freshDb } from '../../db/test-utils/fresh-db';
import {
  insertIntegration,
  listLocalIntegrations,
  setLocalIntegrationExternalUserId,
} from '../../db/repos/webhook-ingress';
import { ensureLocalAccountIdentity, readIdentityId } from './account-identity';

describe('readIdentityId', () => {
  it('prefers structured output and falls back to the text blocks JSON', () => {
    expect(
      readIdentityId(
        { structuredContent: { id: 'member-1' }, content: [{ text: '{"id":"stale"}' }] },
        'id',
      ),
    ).toBe('member-1');
    expect(readIdentityId({ content: [{ text: '{"id":"member-2"}' }] }, 'id')).toBe('member-2');
    expect(
      readIdentityId({ structuredContent: null, content: [{ text: '{"id":"member-5"}' }] }, 'id'),
    ).toBe('member-5');
    expect(
      readIdentityId({ content: [{ text: '{"user":' }, { text: '{"id":42}}' }] }, 'user.id'),
    ).toBe('42');
    expect(
      readIdentityId(
        { content: [{ text: 'Current user:\n\n<json>\n{"id":"member-3","name":"x"}\n</json>' }] },
        'id',
      ),
    ).toBe('member-3');
  });

  it('yields no id for a result the declared path does not reach', () => {
    expect(readIdentityId({ content: [{ text: 'not json' }] }, 'id')).toBeUndefined();
    expect(readIdentityId({ structuredContent: { id: '  ' } }, 'id')).toBeUndefined();
    expect(readIdentityId({ structuredContent: { id: { nested: true } } }, 'id')).toBeUndefined();
    expect(readIdentityId({ structuredContent: { id: 'x' } }, 'user.id')).toBeUndefined();
    expect(readIdentityId(null, 'id')).toBeUndefined();
  });
});

describe('local account identity', () => {
  it('keeps the first resolved id and never overwrites it', async () => {
    const db = freshDb();
    const id = await insertIntegration(db, { provider: 'shortcut' });
    await setLocalIntegrationExternalUserId(db, id, 'member-1');
    await setLocalIntegrationExternalUserId(db, id, 'member-2');
    expect((await listLocalIntegrations(db))[0]?.externalUserId).toBe('member-1');
  });

  it('leaves a provider whose manifest declares no identity lookup untouched', async () => {
    const db = freshDb();
    await insertIntegration(db, { provider: 'generic_webhook' });
    await ensureLocalAccountIdentity(db, 'generic_webhook');
    expect((await listLocalIntegrations(db))[0]?.externalUserId).toBeNull();
  });
});
