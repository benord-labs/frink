import { z } from 'zod';
import { flowSettingsSchema } from './flow-settings-schema';

/** A flow's name and description, as every path that creates or renames a flow accepts them. */
export const flowDetailsSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable(),
});

export const flowGraphNodeSchema = z.object({
  id: z.string().min(1),
  blockType: z.string().min(1),
  parentId: z.string().min(1).optional(),
  label: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
  /** Author-set Fan Out container size; canvas-only, never read by the runtime. */
  size: z
    .object({ width: z.number().positive().finite(), height: z.number().positive().finite() })
    .optional(),
});

export const flowGraphEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  sourceHandle: z.string().optional(),
  label: z.string().optional(),
});

/** A saved graph; keys outside the schema (such as `settings.currentBatchId`) are dropped. */
export const flowGraphSchema = z.object({
  nodes: z.array(flowGraphNodeSchema),
  edges: z.array(flowGraphEdgeSchema),
  settings: flowSettingsSchema,
});

export type FlowGraphInput = z.infer<typeof flowGraphSchema>;
