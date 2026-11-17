import { SquareDashedText } from 'lucide-react';
import { AgentFileItem } from './agent-file-item';

type AgentTextContextItemProps = {
  text: string;
  preview: string;
  onRemove?: () => void;
};

export function AgentTextContextItem({
  text: _text,
  preview,
  onRemove,
}: AgentTextContextItemProps) {
  return (
    <AgentFileItem
      filename={preview.trim().split('\n')[0]}
      icon={SquareDashedText}
      className="max-w-48"
      removeLabel="Remove selected text"
      onRemove={onRemove}
    />
  );
}
