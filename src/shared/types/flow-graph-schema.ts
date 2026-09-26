import { z } from 'zod';

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
