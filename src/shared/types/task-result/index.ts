import { z } from 'zod';

export const taskResultSchema = z.record(z.string(), z.json());
export type TaskResultRecord = z.infer<typeof taskResultSchema>;
