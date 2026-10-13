import { SquareDashedText } from 'lucide-react';
import { AgentFileItem } from './agent-file-item';
import { isPlanFile } from './agent-tool-utils';

type AgentDiffTextContextItemProps = {
  text: string;
  preview: string;
  filePath: string;
  lineNumber?: number;
  onRemove?: () => void;
};

export function AgentDiffTextContextItem({
  text: _text,
  preview: _preview,
  filePath,
  lineNumber,
  onRemove,
}: AgentDiffTextContextItemProps) {
  // A plan selection is prose, so it shows as text rather than as a file.
  const isPlan = isPlanFile(filePath);
  const fileName = filePath.split('/').pop() || filePath;

  return (
    <AgentFileItem
      filename={isPlan ? 'Plan' : fileName}
      icon={isPlan ? SquareDashedText : undefined}
      path={isPlan ? undefined : filePath}
      detail={lineNumber ? `L${lineNumber}` : undefined}
      removeLabel={`Remove selection from ${isPlan ? 'the plan' : fileName}`}
      onRemove={onRemove}
    />
  );
}
