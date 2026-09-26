import { z } from 'zod';
import { APPROVED_PLAN_ID_MAX_CHARS, type ApprovedPlanContext } from './plan';

export const approvedPlanContextSchema: z.ZodType<ApprovedPlanContext> = z.object({
  planId: z.string().trim().min(1).max(APPROVED_PLAN_ID_MAX_CHARS).optional(),
  planText: z.string().trim().min(1),
});
