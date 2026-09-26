import { Image as ImageIcon } from 'lucide-react';
import { memo } from 'react';
import type { ReadImageFile } from '../../../../lib/code-editor/files/use-read-image-file';
import type { MessagePart } from '../../stores/message-store';
import { AgentToolCall } from '../agent-tool-call';
import { AgentToolInterrupted } from '../agent-tool-interrupted';
import { getToolStatus } from '../agent-tool-registry';
import { areToolPropsEqual, getOutputString } from '../agent-tool-utils';
import { firstSubtitle } from '../AgentGenericToolCall';
import { GeneratedImage } from './GeneratedImage';
import { ImagePlaceholder } from './ImagePlaceholder';

type AgentImageGenerationToolProps = {
  part: MessagePart;
  chatStatus?: string;
  useReadImage: ReadImageFile;
};

/**
 * A provider-generated image (codex `imageGeneration`). While the job runs it reserves the image's
 * space with a sweeping placeholder; once saved it is just the picture, no card chrome around it.
 */
export const AgentImageGenerationTool = memo(function AgentImageGenerationTool({
  part,
  chatStatus,
  useReadImage,
}: AgentImageGenerationToolProps) {
  const { isPending, isError, isInterrupted } = getToolStatus(part, chatStatus);
  const prompt = firstSubtitle(part.input);
  const path = getOutputString(part.output, 'path');

  if (isInterrupted && !part.output) {
    return <AgentToolInterrupted toolName="Image generation" subtitle={prompt} />;
  }
  if (isPending) {
    return (
      <div>
        <AgentToolCall icon={ImageIcon} title="Generating image" isPending isError={false} />
        <div className="px-2">
          <ImagePlaceholder />
        </div>
      </div>
    );
  }
  if (isError || !path) {
    return (
      <AgentToolCall
        icon={ImageIcon}
        title={isError ? 'Image generation failed' : 'Generated image'}
        subtitle={isError ? part.errorText : 'Image was not saved to disk'}
        isPending={false}
        isError={isError}
      />
    );
  }
  return (
    <div className="px-2">
      <GeneratedImage path={path} alt={prompt ?? 'Generated image'} useReadImage={useReadImage} />
    </div>
  );
}, areToolPropsEqual);
