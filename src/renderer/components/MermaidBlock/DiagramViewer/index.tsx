import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Download, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react';
import { TransformComponent, TransformWrapper, useControls } from 'react-zoom-pan-pinch';
import { overlayGlass } from '@/lib/overlay-styles';
import { Dialog, DialogPortal, DialogTitle } from '../../ui/dialog';
import { DiagramButton } from '../DiagramButton';

type DiagramViewerProps = {
  svg: string;
  onClose: () => void;
};

function downloadSvg(svg: string): void {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'diagram.svg';
  link.click();
  URL.revokeObjectURL(url);
}

function ZoomControls() {
  const { zoomIn, zoomOut, resetTransform } = useControls();
  // Glass inside the glass sheet on purpose: its backdrop is the diagram panning under it.
  return (
    <div
      className={`absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-full border ${overlayGlass} p-1 shadow-lg`}
    >
      <DiagramButton label="Zoom out" onClick={() => zoomOut()}>
        <ZoomOut />
      </DiagramButton>
      <DiagramButton label="Zoom in" onClick={() => zoomIn()}>
        <ZoomIn />
      </DiagramButton>
      <div className="mx-0.5 h-4 w-px bg-border" />
      <DiagramButton label="Reset zoom" onClick={() => resetTransform()}>
        <RotateCcw />
      </DiagramButton>
    </div>
  );
}

/** Expanded diagram on a popover sheet: scroll to zoom, drag to pan, Esc to close. */
export function DiagramViewer({ svg, onClose }: DiagramViewerProps) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPortal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/10 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className={`fixed inset-6 z-50 flex flex-col overflow-hidden rounded-2xl border ${overlayGlass} shadow-2xl outline-hidden duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95`}
        >
          <header className="flex items-center justify-between border-b border-border px-4 py-2">
            <DialogTitle className="text-sm font-medium">Diagram</DialogTitle>
            <div className="flex gap-1">
              <DiagramButton label="Download as SVG" onClick={() => downloadSvg(svg)}>
                <Download />
              </DiagramButton>
              <DiagramButton label="Close" onClick={onClose}>
                <X />
              </DiagramButton>
            </div>
          </header>
          <div className="relative min-h-0 flex-1">
            <TransformWrapper
              minScale={0.1}
              maxScale={8}
              centerOnInit
              limitToBounds={false}
              smooth
              wheel={{ step: 0.1 }}
              panning={{ velocityDisabled: true }}
            >
              <ZoomControls />
              <TransformComponent
                wrapperClass="w-full! h-full!"
                contentClass="w-full! h-full! flex items-center justify-center"
              >
                <div
                  className="p-8 [&_svg]:h-auto [&_svg]:max-w-none"
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: DOMPurify-sanitised by mermaid.render() (securityLevel 'strict')
                  dangerouslySetInnerHTML={{ __html: svg }}
                />
              </TransformComponent>
            </TransformWrapper>
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
