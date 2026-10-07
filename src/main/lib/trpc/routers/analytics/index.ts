import { messageSentEventSchema } from '../../../../../shared/types/analytics';
import { trackMessageSent } from '../../../analytics';
import { publicProcedure, router } from '../../index';

/** Usage events the renderer reports. The input schema is the boundary that keeps content out. */
export const analyticsRouter = router({
  messageSent: publicProcedure
    .input(messageSentEventSchema)
    .mutation(({ input }) => trackMessageSent(input)),
});
