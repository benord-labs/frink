import { eq } from 'drizzle-orm';
import type { ManifestInputsProjection } from '../../../../../shared/lib/flows/json-schema-to-manifest-inputs';
import type { getDatabase } from '../..';
import { pluginNodeSchemas } from '../../schema/plugin-installations';

type Db = ReturnType<typeof getDatabase>;

/** Exactly what the probe projects, so the form and the preflight read the same shape the probe wrote. */
export type PluginNodeSchema = ManifestInputsProjection;

/** One probed schema per catalog action; a re-probe replaces the row in place. */
export function upsertPluginNodeSchema(
  db: Db,
  row: { pluginId: string; actionId: string } & PluginNodeSchema,
): void {
  db.insert(pluginNodeSchemas)
    .values(row)
    .onConflictDoUpdate({
      target: [pluginNodeSchemas.pluginId, pluginNodeSchemas.actionId],
      set: { inputs: row.inputs, unsupportedFields: row.unsupportedFields },
    })
    .run();
}

/** Synchronous by design: the node palette and dispatch preflight read it inline. */
export function listPluginNodeSchemas(db: Db, pluginId: string): Map<string, PluginNodeSchema> {
  const rows = db
    .select()
    .from(pluginNodeSchemas)
    .where(eq(pluginNodeSchemas.pluginId, pluginId))
    .all();
  return new Map(
    rows.map((row) => [row.actionId, { inputs: row.inputs, unsupportedFields: row.unsupportedFields }]),
  );
}
