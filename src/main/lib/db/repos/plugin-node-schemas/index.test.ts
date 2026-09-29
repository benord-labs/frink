import { describe, expect, it } from 'vitest';
import { freshDb } from '../../test-utils/fresh-db';
import { listPluginNodeSchemas, upsertPluginNodeSchema } from '.';

describe('plugin node schema cache', () => {
  it('stores one schema per catalog action and overwrites it on re-probe', () => {
    const db = freshDb();
    upsertPluginNodeSchema(db, {
      pluginId: 'posthog',
      actionId: 'posthog.list_errors',
      inputs: { status: { type: 'string' } },
      unsupportedFields: ['filterGroup'],
    });
    upsertPluginNodeSchema(db, {
      pluginId: 'posthog',
      actionId: 'posthog.list_errors',
      inputs: { status: { type: 'string' }, dateRange: { type: 'json' } },
      unsupportedFields: [],
    });
    upsertPluginNodeSchema(db, {
      pluginId: 'sentry',
      actionId: 'sentry.list_issues',
      inputs: {},
      unsupportedFields: [],
    });

    expect(listPluginNodeSchemas(db, 'posthog')).toEqual(
      new Map([
        [
          'posthog.list_errors',
          {
            inputs: { status: { type: 'string' }, dateRange: { type: 'json' } },
            unsupportedFields: [],
          },
        ],
      ]),
    );
    expect(listPluginNodeSchemas(db, 'slack').size).toBe(0);
  });
});
