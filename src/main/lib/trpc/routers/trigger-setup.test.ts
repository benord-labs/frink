import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as database from '../../db';
import { insertIntegration } from '../../db/repos/webhook-ingress';
import { freshDb } from '../../db/test-utils/fresh-db';
import { createId } from '../../db/utils';

const localDb = freshDb();
vi.spyOn(database, 'getDatabase').mockReturnValue(localDb);
import { triggerSetupRouter } from './trigger-setup';

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
