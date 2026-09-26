import { dirname } from 'node:path';
import { app, shell } from 'electron';
import log from 'electron-log';
import { publicProcedure, router } from '../index';

export const debugRouter = router({
  /**
   * Get system information for debug display
   */
  getSystemInfo: publicProcedure.query(() => {
    // Log file path (electron-log: macOS ~/Library/Logs/{app name}/main.log, etc.)
    let logFilePath: string | null = null;
    try {
      logFilePath = log.transports.file.getFile().path;
    } catch {
      // file transport not available
    }

    return {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      userDataPath: app.getPath('userData'),
      logFilePath,
    };
  }),

  /**
   * Open the folder containing the main process log file (for built app debugging)
   */
  openLogFolder: publicProcedure.mutation(() => {
    try {
      const filePath = log.transports.file.getFile().path;
      shell.openPath(dirname(filePath));
      return { success: true };
    } catch {
      return { success: false };
    }
  }),

  /**
   * Open userData folder in system file manager
   */
  openUserDataFolder: publicProcedure.mutation(() => {
    const userDataPath = app.getPath('userData');
    shell.openPath(userDataPath);
    return { success: true };
  }),
});
