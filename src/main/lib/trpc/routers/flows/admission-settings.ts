import { z } from 'zod';
import {
  MAX_CONCURRENT_FLOW_RUNS,
  MIN_CONCURRENT_FLOW_RUNS,
} from '../../../flows/admission/config';
import {
  getFlowAdmissionSettings,
  updateFlowAdmissionSettings,
} from '../../../flows/admission/runtime';
import { publicProcedureRaw } from '../../index';

const admissionSettingsPatchSchema = z
  .object({
    concurrency_limit_enabled: z.boolean().optional(),
    max_concurrent_runs: z
      .number()
      .int()
      .min(MIN_CONCURRENT_FLOW_RUNS)
      .max(MAX_CONCURRENT_FLOW_RUNS)
      .optional(),
  })
  .refine(
    (input) =>
      input.concurrency_limit_enabled !== undefined || input.max_concurrent_runs !== undefined,
    { message: 'At least one admission setting is required.' },
  )
  .transform((input) => ({
    ...(input.concurrency_limit_enabled === undefined
      ? {}
      : { concurrencyLimitEnabled: input.concurrency_limit_enabled }),
    ...(input.max_concurrent_runs === undefined
      ? {}
      : { maxConcurrentRuns: input.max_concurrent_runs }),
  }));

export const flowAdmissionSettingsProcedures = {
  getAdmissionSettings: publicProcedureRaw.query(() => getFlowAdmissionSettings()),
  updateAdmissionSettings: publicProcedureRaw
    .input(admissionSettingsPatchSchema)
    .mutation(({ input }) => updateFlowAdmissionSettings(input)),
};
