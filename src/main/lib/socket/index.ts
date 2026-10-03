/**
 * Exports the main functions for initializing and using the socket connection.
 */

import { broadcastToRenderer } from './client';
import {
  setBackgroundRosterPublisher,
  setSubagentTaskPublisher,
} from './streaming/subagent-task-status';

// Wire the display-only subagent-status lane at boot. This module is evaluated via
// src/main/index.ts's `./lib/socket` import — if a refactor ever imports './client' directly
// instead, the publisher stays unset and the lane silently goes dark.
setSubagentTaskPublisher((payload) => broadcastToRenderer('socket:subagent-task-changed', payload));
setBackgroundRosterPublisher((payload) =>
  broadcastToRenderer('socket:background-tasks-changed', payload),
);

export { onExecuteRequest, onStop, sendMessage, sendPermissionResponse, sendStop } from './client';
