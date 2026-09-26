import { getUsageActivity, getUsageHistory } from '../../provider/usage-history';
import { captureMainException } from '../../sentry/init';
import { publicProcedure, router } from '../index';

/** A failure reaches Sentry as well as the Usage tab, which only shows "try again shortly". */
async function reported<T>(surface: string, run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    captureMainException(err, { surface });
    throw err;
  }
}

/** Frink usage history (Settings → Usage): the heatmap, streaks and most used, from transcripts. */
export const usageHistoryRouter = router({
  get: publicProcedure.query(() => reported('usage-history-get', getUsageHistory)),
  activity: publicProcedure.query(() =>
    reported('usage-history-activity', () => getUsageActivity()),
  ),
});
