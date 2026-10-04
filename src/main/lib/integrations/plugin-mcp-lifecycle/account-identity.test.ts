import { describe, expect, it, vi } from 'vitest';
import { freshDb } from '../../db/test-utils/fresh-db';
import {
  insertIntegration,
  listLocalIntegrations,
  setLocalIntegrationExternalUserId,
} from '../../db/repos/webhook-ingress';
import { ensureLocalAccountIdentity, lookUpIdentity, readIdentityId } from './account-identity';

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

  it('indexes a list with a numeric path segment', () => {
    expect(readIdentityId({ structuredContent: { userIds: ['93748974'] } }, 'userIds.0')).toBe(
      '93748974',
    );
    expect(readIdentityId({ content: [{ text: '{"userIds":[183]}' }] }, 'userIds.0')).toBe('183');
    expect(readIdentityId({ structuredContent: { userIds: [] } }, 'userIds.0')).toBeUndefined();
    expect(readIdentityId({ structuredContent: { userIds: ['x'] } }, 'userIds.id')).toBeUndefined();
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

describe('ClickUp identity lookup', () => {
  const target = {
    config: {
      name: 'clickup',
      type: 'custom' as const,
      authType: 'none' as const,
      command: '',
      url: 'https://mcp.clickup.com/mcp',
    },
    credentials: undefined,
    serverName: 'clickup',
  };
  const resolvePluginServerTarget = vi.fn(async () => ({ ok: true as const, target }));

  it('asks the server who "me" is', async () => {
    const callServerTool = vi.fn(async () => ({
      ok: true as const,
      result: { content: [{ type: 'text' as const, text: '{"userIds":["93748974"]}' }] },
    }));
    await expect(
      lookUpIdentity('clickup', { resolvePluginServerTarget, callServerTool }),
    ).resolves.toBe('93748974');
    expect(callServerTool).toHaveBeenCalledExactlyOnceWith(
      target.config,
      undefined,
      'clickup_resolve_assignees',
      { assignees: ['me'] },
    );
  });

  it('names nobody when the server refuses, or answers with an empty list', async () => {
    const refused = vi.fn(async () => ({
      ok: false as const,
      reason: 'transport' as const,
      message: 'workspace_id is required',
    }));
    const empty = vi.fn(async () => ({
      ok: true as const,
      result: { content: [{ type: 'text' as const, text: '{"userIds":[]}' }] },
    }));
    await expect(
      lookUpIdentity('clickup', { resolvePluginServerTarget, callServerTool: refused }),
    ).resolves.toBeUndefined();
    await expect(
      lookUpIdentity('clickup', { resolvePluginServerTarget, callServerTool: empty }),
    ).resolves.toBeUndefined();
  });

  it('stamps the answer on the account', async () => {
    const db = freshDb();
    await insertIntegration(db, { provider: 'clickup' });
    await ensureLocalAccountIdentity(db, 'clickup', undefined, async () => '93748974');
    expect((await listLocalIntegrations(db))[0]?.externalUserId).toBe('93748974');
  });

  it('leaves the account without an identity when the lookup names nobody or throws', async () => {
    const db = freshDb();
    await insertIntegration(db, { provider: 'clickup' });
    await ensureLocalAccountIdentity(db, 'clickup', undefined, async () => undefined);
    await ensureLocalAccountIdentity(db, 'clickup', undefined, async () => {
      throw new Error('offline');
    });
    expect((await listLocalIntegrations(db))[0]?.externalUserId).toBeNull();
  });
});
