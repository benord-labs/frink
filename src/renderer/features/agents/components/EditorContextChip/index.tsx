import type { CodeSelectionContext } from '../../lib/queue-utils';
import { AgentFileItem } from '../../ui/agent-file-item';

type EditorContextChipProps = {
  selection: Pick<CodeSelectionContext, 'fileName' | 'startLine' | 'endLine'> | null | undefined;
  /** Name of the open file that rides the next message; null when nothing from it is sent. */
  fileName: string | null | undefined;
  onRemoveSelection: () => void;
  onRemoveFile: () => void;
};

/** What the editor adds to the next message, as a removable chip in the composer's attachment
 *  strip. A selection stands in for its file, so removing it removes both. */
export function EditorContextChip({
  selection,
  fileName,
  onRemoveSelection,
  onRemoveFile,
}: EditorContextChipProps) {
  if (selection) {
    const lines = `${selection.startLine}-${selection.endLine}`;
    return (
      <AgentFileItem
        filename={selection.fileName}
        detail={`L${lines}`}
        removeLabel={`Remove code selection and file from context: ${selection.fileName} lines ${lines}`}
        onRemove={() => {
          onRemoveSelection();
          onRemoveFile();
        }}
      />
    );
  }
  if (!fileName) return null;
  return (
    <AgentFileItem
      filename={fileName}
      removeLabel={`Remove ${fileName} from context`}
      onRemove={onRemoveFile}
    />
  );
}
