/**
 * Format task data into a message with visual bubble marker
 * (similar to trigger bubbles but for tasks)
 */

export type TaskData = {
  id: string;
  title: string;
  description: string;
};

/**
 * Marker prefix for task bubble data in messages
 * Format: <!--TASK_BUBBLE:{json}-->
 */
const TASK_BUBBLE_MARKER = '<!--TASK_BUBBLE:';
const TASK_BUBBLE_END = '-->';

/**
 * Format task into a message with bubble marker for visual rendering
 * Returns format: <!--TASK_BUBBLE:{json}-->
 * The task content is stored in the JSON marker for the bubble to display
 * The visible message text is empty (task content is not duplicated)
 */
export function formatTaskMessage(task: TaskData): string {
  // Build the hidden marker with full task metadata
  const bubbleData = {
    id: task.id,
    title: task.title,
    description: task.description, // Full description for bubble display
  };

  const jsonData = JSON.stringify(bubbleData).replace(/-->/g, '--\\u003e');
  // Just the marker - no task content in message body (it will be shown in the bubble)
  return `${TASK_BUBBLE_MARKER}${jsonData}${TASK_BUBBLE_END}`;
}

/**
 * Extract task bubble data from a message if present
 */
export function extractTaskBubbleData(message: string): {
  taskData: TaskData | null;
  fullPrompt: string;
} {
  if (!message.startsWith(TASK_BUBBLE_MARKER)) {
    return { taskData: null, fullPrompt: message };
  }

  const endIndex = message.indexOf(TASK_BUBBLE_END);
  if (endIndex === -1) {
    return { taskData: null, fullPrompt: message };
  }

  try {
    const jsonStr = message.slice(TASK_BUBBLE_MARKER.length, endIndex);
    const taskData = JSON.parse(jsonStr) as TaskData;
    const fullPrompt = message.slice(endIndex + TASK_BUBBLE_END.length).trim();
    return { taskData, fullPrompt };
  } catch {
    return { taskData: null, fullPrompt: message };
  }
}
