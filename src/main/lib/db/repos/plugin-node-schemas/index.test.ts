import { describe, expect, it } from 'vitest';
import { freshDb } from '../../test-utils/fresh-db';
import { listPluginNodeSchemas, listPluginNodeSchemasByPlugin, upsertPluginNodeSchema } from '.';

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

  it('reads several plugins at once, grouped by plugin, leaving out unrequested ones', () => {
    const db = freshDb();
    const schema = { inputs: { query: { type: 'string' as const } }, unsupportedFields: [] };
    upsertPluginNodeSchema(db, { pluginId: 'posthog', actionId: 'posthog.list_errors', ...schema });
    upsertPluginNodeSchema(db, { pluginId: 'sentry', actionId: 'sentry.list_issues', ...schema });
    upsertPluginNodeSchema(db, { pluginId: 'sentry', actionId: 'sentry.get_issue', ...schema });
    upsertPluginNodeSchema(db, { pluginId: 'slack', actionId: 'slack.post', ...schema });

    const grouped = listPluginNodeSchemasByPlugin(db, ['posthog', 'sentry', 'linear']);
    expect([...grouped.keys()].sort()).toEqual(['posthog', 'sentry']);
    expect(grouped.get('posthog')).toEqual(listPluginNodeSchemas(db, 'posthog'));
    expect(grouped.get('sentry')).toEqual(listPluginNodeSchemas(db, 'sentry'));
    expect(listPluginNodeSchemasByPlugin(db, []).size).toBe(0);
  });
});
