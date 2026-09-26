import { toast } from 'sonner';

// Threshold for auto-converting large pasted text to a file (5KB)
// Text larger than this will be saved as a file attachment instead of pasted inline
const LARGE_PASTE_THRESHOLD = 5_000;

// Maximum characters allowed for paste (10KB of text)
// ContentEditable elements become extremely slow with large text content,
// causing browser/system freeze. 50KB still causes noticeable lag on some systems.
// For larger content, users should attach it as a file instead.
const MAX_PASTE_LENGTH = 10_000;

// Threshold for showing "very large" warning (1MB+)
const VERY_LARGE_THRESHOLD = 1_000_000;

// Callback type for adding large pasted text as a file
export type AddPastedTextFn = (text: string) => Promise<void>;

/**
 * Insert text at the current cursor position in a contentEditable element.
 * Truncates large text to prevent browser freeze.
 * Also accounts for existing content to prevent total size from exceeding limit.
 *
 * @param text - The text to insert
 * @param editableElement - The contentEditable element to dispatch input event to
 */
function insertTextAtCursor(text: string, editableElement: Element): void {
  // Check existing content size to prevent exceeding total limit
  const existingLength = editableElement.textContent?.length || 0;
  const availableSpace = Math.max(0, MAX_PASTE_LENGTH - existingLength);

  // Truncate based on available space (not just paste size)
  let textToInsert = text;
  const effectiveLimit = Math.min(text.length, availableSpace);

  if (text.length > effectiveLimit) {
    textToInsert = text.slice(0, effectiveLimit);
    // Show toast warning to user
    const originalKB = Math.round(text.length / 1024);

    if (availableSpace === 0) {
      // No space left at all
      toast.warning('Cannot paste: input is full', {
        description: 'Please clear some text or attach content as a file instead.',
      });
      return;
    } else if (text.length > VERY_LARGE_THRESHOLD) {
      const originalMB = (text.length / 1_000_000).toFixed(1);
      toast.warning(`Text truncated`, {
        description: `Original text was ${originalMB}MB. Please attach as a file instead.`,
      });
    } else {
      const truncatedKB = Math.round(effectiveLimit / 1024);
      toast.warning(`Text truncated to ${truncatedKB}KB`, {
        description: `Original text was ${originalKB}KB. Consider attaching as a file instead.`,
      });
    }
  }

  // Insert synchronously - the text is already truncated to a safe size
  const selection = window.getSelection();
  if (selection && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const textNode = document.createTextNode(textToInsert);
    range.insertNode(textNode);
    // Move cursor to end of inserted text
    range.setStartAfter(textNode);
    range.setEndAfter(textNode);
    selection.removeAllRanges();
    selection.addRange(range);
    // Trigger input event on the contentEditable element for editor to update state
    const inputEvent = new Event('input', { bubbles: true });
    editableElement.dispatchEvent(inputEvent);
  }
}

/**
 * Handle paste event for contentEditable elements.
 * Extracts images and passes them to handleAddAttachments.
 * For large text (>LARGE_PASTE_THRESHOLD), saves as a file attachment.
 * For smaller text, pastes as plain text only (prevents HTML).
 *
 * @param e - The clipboard event
 * @param handleAddAttachments - Callback to handle image attachments
 * @param addPastedText - Optional callback to save large text as a file
 */
export function handlePasteEvent(
  e: React.ClipboardEvent,
  handleAddAttachments: (files: File[]) => void,
  addPastedText?: AddPastedTextFn,
): void {
  const files = Array.from(e.clipboardData.items)
    .filter((item) => item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter(Boolean) as File[];

  if (files.length > 0) {
    e.preventDefault();
    handleAddAttachments(files);
  } else {
    // Paste as plain text only (prevents HTML from being pasted)
    const text = e.clipboardData.getData('text/plain');
    if (text) {
      e.preventDefault();

      // Large text: save as file attachment instead of pasting inline
      if (text.length > LARGE_PASTE_THRESHOLD && addPastedText) {
        addPastedText(text);
        return;
      }

      // Get the contentEditable element
      const target = e.currentTarget as HTMLElement;
      const editableElement = target.closest('[contenteditable="true"]') || target;
      insertTextAtCursor(text, editableElement);
    }
  }
}
