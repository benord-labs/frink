import { z } from 'zod';
import { getTrayEnabled, setTrayEnabled } from '../../../windows/tray';
import { publicProcedure, router } from '../index';

export const trayRouter = router({
  showStatus: publicProcedure.query(() => ({
    enabled: getTrayEnabled(),
    appliesOnRestart: process.platform === 'linux',
  })),
  setShowStatus: publicProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ input }) => ({ enabled: setTrayEnabled(input.enabled) })),
});
