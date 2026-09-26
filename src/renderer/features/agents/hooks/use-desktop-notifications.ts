/**
 * Desktop notifications hook - provides native OS notifications for agent events.
 * Uses Electron's Notification API via the IPC bridge in desktopApi.
 */

import { useAtomValue } from 'jotai';
import { useCallback, useEffect, useRef } from 'react';
import { desktopNotificationsEnabledAtom } from '../../../lib/atoms';
import { isDesktopApp } from '../../../lib/utils/platform';

// throttle interval to prevent notification spam (ms)
const NOTIFICATION_THROTTLE_MS = 3000;

// priority levels for notifications (higher = more important)
const NOTIFICATION_PRIORITY = {
  error: 3,
  complete: 0,
} as const;

type NotificationPriority = keyof typeof NOTIFICATION_PRIORITY;

type NotificationOptions = {
  title: string;
  body: string;
  silent?: boolean;
  priority?: NotificationPriority;
};

export function useDesktopNotifications() {
  const notificationsEnabled = useAtomValue(desktopNotificationsEnabledAtom);

  // track last notification time to throttle rapid-fire notifications
  const lastNotificationTime = useRef<number>(0);
  const pendingNotification = useRef<NotificationOptions | null>(null);
  const throttleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup timer on unmount to prevent memory leak
  useEffect(() => {
    return () => {
      if (throttleTimer.current) {
        clearTimeout(throttleTimer.current);
        throttleTimer.current = null;
      }
    };
  }, []);

  const showNotification = useCallback(
    (
      title: string,
      body: string,
      options?: { silent?: boolean; priority?: NotificationPriority },
    ) => {
      // Check if notifications are enabled
      if (!notificationsEnabled) {
        return;
      }

      if (!isDesktopApp()) {
        // fallback for web - use browser Notification API if available
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification(title, { body, silent: options?.silent });
        }
        return;
      }

      const now = Date.now();
      const timeSinceLastNotification = now - lastNotificationTime.current;
      const currentPriority = options?.priority ? NOTIFICATION_PRIORITY[options.priority] : 0;

      // if we're within throttle window, check priority
      if (timeSinceLastNotification < NOTIFICATION_THROTTLE_MS) {
        const pendingPriority = pendingNotification.current?.priority
          ? NOTIFICATION_PRIORITY[pendingNotification.current.priority]
          : 0;

        // Only queue if higher or equal priority than pending
        if (currentPriority >= pendingPriority) {
          pendingNotification.current = {
            title,
            body,
            silent: options?.silent,
            priority: options?.priority,
          };
        }

        // set up a timer to show the pending notification after throttle period
        if (!throttleTimer.current) {
          throttleTimer.current = setTimeout(() => {
            throttleTimer.current = null;
            if (pendingNotification.current) {
              const pending = pendingNotification.current;
              pendingNotification.current = null;
              // Directly send notification without recursive call to avoid re-throttling
              lastNotificationTime.current = Date.now();
              window.desktopApi?.showNotification({ title: pending.title, body: pending.body });
            }
          }, NOTIFICATION_THROTTLE_MS - timeSinceLastNotification);
        }
        return;
      }

      lastNotificationTime.current = now;

      // use the IPC bridge to show native notification
      window.desktopApi?.showNotification({ title, body });
    },
    [notificationsEnabled],
  );

  const notifyAgentComplete = useCallback(
    (chatName: string) => {
      // don't notify if window is focused - user is already watching
      if (document.hasFocus()) {
        return;
      }

      const title = 'Agent Complete';
      const body = chatName ? `Finished working on "${chatName}"` : 'Agent has completed its task';
      showNotification(title, body, { priority: 'complete' });
    },
    [showNotification],
  );

  const notifyAgentError = useCallback(
    (errorMessage: string) => {
      // always notify on errors, even if window is focused
      const title = 'Agent Error';
      const body = errorMessage.length > 100 ? `${errorMessage.slice(0, 100)}...` : errorMessage;
      showNotification(title, body, { priority: 'error' });
    },
    [showNotification],
  );

  const requestPermission = useCallback(async (): Promise<NotificationPermission> => {
    if (isDesktopApp()) {
      // desktop apps don't need explicit permission for notifications
      return 'granted';
    }

    // for web, request browser permission
    if ('Notification' in window) {
      return await Notification.requestPermission();
    }

    return 'denied';
  }, []);

  return {
    showNotification,
    notifyAgentComplete,
    notifyAgentError,
    requestPermission,
  };
}
