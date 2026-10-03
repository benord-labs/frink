import { z } from 'zod';
import {
  createMobilePairing,
  disableMobileAccess,
  enableMobileAccess,
  mobileAccessStatus,
  revokeMobileDevice,
} from '../../mobile';
import { publicProcedure, router } from '../index';

/** Administration stays on trusted desktop IPC; the network bridge exposes none of these. */
export const mobileRouter = router({
  status: publicProcedure.query(() => mobileAccessStatus()),
  enable: publicProcedure.mutation(() => enableMobileAccess()),
  disable: publicProcedure.mutation(() => disableMobileAccess()),
  pair: publicProcedure.mutation(() => createMobilePairing()),
  revoke: publicProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(({ input }) => revokeMobileDevice(input.id)),
});
