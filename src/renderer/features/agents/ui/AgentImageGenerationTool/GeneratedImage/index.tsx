import { Image as ImageIcon } from 'lucide-react';
import { useState } from 'react';
import type { ReadImageFile } from '../../../../../lib/code-editor/files/use-read-image-file';
import { AgentToolCall } from '../../agent-tool-call';
import { ImageFullscreen } from '../../ImageFullscreen';
import { ImagePlaceholder } from '../ImagePlaceholder';

type GeneratedImageProps = {
  path: string;
  alt: string;
  useReadImage: ReadImageFile;
};

/** The saved file, read back as a data URL; the transcript never carries the bitmap itself. */
export function GeneratedImage({ path, alt, useReadImage }: GeneratedImageProps) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const { dataUrl, error } = useReadImage(path);
  if (error) {
    return (
      <AgentToolCall
        icon={ImageIcon}
        title="Generated image"
        subtitle={error.message}
        isPending={false}
        isError
        isNested
      />
    );
  }
  if (!dataUrl) return <ImagePlaceholder />;
  return (
    <>
      <img
        src={dataUrl}
        alt={alt}
        className="h-72 w-auto max-w-full rounded-md object-contain cursor-zoom-in"
        tabIndex={0}
        onClick={() => setIsFullscreen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setIsFullscreen(true);
          }
        }}
      />
      {isFullscreen && (
        <ImageFullscreen
          images={[{ id: path, filename: alt, url: dataUrl }]}
          onClose={() => setIsFullscreen(false)}
        />
      )}
    </>
  );
}
