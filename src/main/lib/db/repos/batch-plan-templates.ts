import { desc, eq } from 'drizzle-orm';
import type { getDatabase } from '../index';
import { type BatchPlanTemplate, batchPlanTemplates, type NewBatchPlanTemplate } from '../schema';

type Db = ReturnType<typeof getDatabase>;

/** Template names are unique case-insensitively, so a rename onto an existing name is rejected. */
export class BatchPlanTemplateNameTakenError extends Error {
  constructor() {
    super('A batch plan template with that name already exists');
    this.name = 'BatchPlanTemplateNameTakenError';
  }
}

const NAME_TAKEN_ERROR_REGEX = /batch_plan_templates_name_uniq/i;

export async function createBatchPlanTemplate(
  db: Db,
  input: NewBatchPlanTemplate,
): Promise<BatchPlanTemplate> {
  const [row] = await db.insert(batchPlanTemplates).values(input).returning();
  return row;
}

export async function listBatchPlanTemplates(db: Db): Promise<BatchPlanTemplate[]> {
  return db.select().from(batchPlanTemplates).orderBy(desc(batchPlanTemplates.updatedAt));
}

export async function renameBatchPlanTemplate(
  db: Db,
  id: string,
  name: string,
): Promise<BatchPlanTemplate | null> {
  try {
    const [row] = await db
      .update(batchPlanTemplates)
      .set({ name, updatedAt: new Date() })
      .where(eq(batchPlanTemplates.id, id))
      .returning();
    return row ?? null;
  } catch (error) {
    if (NAME_TAKEN_ERROR_REGEX.test(String(error))) throw new BatchPlanTemplateNameTakenError();
    throw error;
  }
}

export async function deleteBatchPlanTemplate(db: Db, id: string): Promise<void> {
  await db.delete(batchPlanTemplates).where(eq(batchPlanTemplates.id, id));
}
