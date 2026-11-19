import { pathLabel } from '../../../../../shared/lib/mentions/parse-mention';
import { findProjectForPath } from '@/lib/workspace-context/project-paths';
import type { CodeSelectionContext } from '../../lib/queue-utils';
import { AgentFileItem } from '../../ui/agent-file-item';

type EditorContextChipProps = {
  selection:
    | Pick<CodeSelectionContext, 'fileName' | 'filePath' | 'startLine' | 'endLine'>
    | null
    | undefined;
  /** Name of the open file that rides the next message; null when nothing from it is sent. */
  fileName: string | null | undefined;
  /** Full path of that open file, shown in the badge's tooltip. */
  filePath?: string | null;
  /** The projects linked to the chat; a selection from one names it, as its mention does. */
  linkedProjects?: ReadonlyArray<{ name: string; path: string }>;
  onRemoveSelection: () => void;
  onRemoveFile: () => void;
};

/** What the editor adds to the next message, as a removable chip in the composer's attachment
 *  strip. A selection stands in for its file, so removing it removes both. */
export function EditorContextChip({
  selection,
  fileName,
  filePath,
  linkedProjects = [],
  onRemoveSelection,
  onRemoveFile,
}: EditorContextChipProps) {
  if (selection) {
    const lines = `${selection.startLine}-${selection.endLine}`;
    // A selection from another project names its file by full path; the chip shows the name,
    // as the sent message's chip does.
    const name = pathLabel(selection.fileName);
    return (
      <AgentFileItem
        filename={name}
        path={selection.filePath}
        project={findProjectForPath(selection.filePath, linkedProjects)?.name}
        detail={`L${lines}`}
        removeLabel={`Remove code selection and file from context: ${name} lines ${lines}`}
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
      path={filePath ?? undefined}
      removeLabel={`Remove ${fileName} from context`}
      onRemove={onRemoveFile}
    />
  );
}
