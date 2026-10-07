import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as database from '../../db';
import { insertIntegration, insertWebhookEndpoint } from '../../db/repos/webhook-ingress';
import { freshDb } from '../../db/test-utils/fresh-db';
import { createId } from '../../db/utils';

const localDb = freshDb();
vi.spyOn(database, 'getDatabase').mockReturnValue(localDb);
import * as identity from '../../integrations/plugin-mcp-lifecycle/account-identity';
import * as webhooks from '../../webhooks';
import { triggerSetupRouter } from './trigger-setup';

const ensureLocalAccountIdentity = vi
  .spyOn(identity, 'ensureLocalAccountIdentity')
  .mockResolvedValue(undefined);
const localTriggerOptions = vi.spyOn(webhooks, 'localTriggerOptions');
const registerLocalTrigger = vi.spyOn(webhooks, 'registerLocalTrigger');

const caller = triggerSetupRouter.createCaller({ getWindow: () => null });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('locally minted trigger setup', () => {
  // Ids minted on this machine are base-36, not UUIDs, so the shared endpoint input takes text.
  it('accepts a locally minted pair of ids and still refuses an empty one', async () => {
    await expect(
      caller.confirmNotion({
        integrationId: createId(),
        webhookId: createId(),
        generation: 'gen',
        candidate: 'notion:pending:1',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      caller.importVendorWebhook({ integrationId: '', webhookId: createId(), secret: 'k' }),
    ).rejects.toThrow();
  });

  // The card reads a failed save off the thrown error, so a local refusal has to throw as well.
  it('serves a Sentry row this machine minted', async () => {
    const integrationId = await insertIntegration(localDb, { provider: 'sentry' });

    await expect(
      caller.restartNotion({
        integrationId,
        webhookId: createId(),
        generation: 'g',
        candidate: null,
      }),
    ).rejects.toMatchObject({ message: 'Only a Notion trigger is set up this way.' });
    await expect(
      caller.importVendorWebhook({ integrationId, webhookId: createId(), secret: 'sentry-key' }),
    ).rejects.toMatchObject({ message: 'Trigger not found.' });
  });

  it('refuses an id that names no account on this machine', async () => {
    await expect(
      caller.options({ integrationId: createId(), webhookId: createId() }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('API-token trigger setup learns who the account belongs to', () => {
  async function clickupTrigger() {
    const integrationId = await insertIntegration(localDb, { provider: 'clickup' });
    const webhookId = await insertWebhookEndpoint(localDb, {
      integrationId,
      provider: 'clickup',
      pathToken: randomBytes(32).toString('hex'),
      subscribeKeyEncrypted: 'sealed-subscribe-key',
      signingSecretEncrypted: 'sealed-signing-secret',
    });
    return { integrationId, webhookId };
  }
  const oneWorkspace = { options: [{ id: 'ws-1', label: 'Acme' }], selection: 'one' as const };

  it('looks the owner up for that account once ClickUp is listening', async () => {
    const ids = await clickupTrigger();
    localTriggerOptions.mockResolvedValue(oneWorkspace);
    registerLocalTrigger.mockResolvedValue({ ok: true });

    await expect(caller.configureApiToken({ ...ids, apiKey: 'pk_test' })).resolves.toEqual({
      success: true,
      options: [],
    });
    expect(ensureLocalAccountIdentity).toHaveBeenCalledExactlyOnceWith(
      localDb,
      'clickup',
      ids.integrationId,
    );
    // The lookup follows the registration, so a refused key is never the reason it runs.
    expect(registerLocalTrigger.mock.invocationCallOrder[0]).toBeLessThan(
      ensureLocalAccountIdentity.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('looks nobody up when ClickUp refuses the registration', async () => {
    const ids = await clickupTrigger();
    localTriggerOptions.mockResolvedValue(oneWorkspace);
    registerLocalTrigger.mockResolvedValue({ ok: false, reason: 'ClickUp said no.' });

    await expect(caller.configureApiToken({ ...ids, apiKey: 'pk_test' })).rejects.toMatchObject({
      message: 'ClickUp said no.',
    });
    expect(ensureLocalAccountIdentity).not.toHaveBeenCalled();
  });

  it('looks nobody up while the user still has a workspace to choose', async () => {
    const ids = await clickupTrigger();
    const two = [
      { id: 'ws-1', label: 'Acme' },
      { id: 'ws-2', label: 'Globex' },
    ];
    localTriggerOptions.mockResolvedValue({ options: two, selection: 'one' });

    await expect(caller.configureApiToken({ ...ids, apiKey: 'pk_test' })).resolves.toEqual({
      success: false,
      options: two,
    });
    expect(registerLocalTrigger).not.toHaveBeenCalled();
    expect(ensureLocalAccountIdentity).not.toHaveBeenCalled();
  });
});
