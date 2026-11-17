import { z } from 'zod';
import { getKeepAwakeEnabled, setKeepAwakeEnabled } from '../../power';
import { publicProcedure, router } from '../index';

export const powerRouter = router({
  keepAwakeWhileWorking: publicProcedure.query(() => ({ enabled: getKeepAwakeEnabled() })),
  setKeepAwakeWhileWorking: publicProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ input }) => ({ enabled: setKeepAwakeEnabled(input.enabled) })),
});
