import { Button } from '@benord-labs/frink-primitives';
import type { ReactNode } from 'react';

type DiagramButtonProps = {
  label: string;
  onClick: () => void;
  children: ReactNode;
};

/** Quiet icon action for the diagram toolbars; the icon inherits muted → foreground on hover. */
export function DiagramButton({ label, onClick, children }: DiagramButtonProps) {
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="size-6 rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground [&_svg]:size-3.5"
    >
      {children}
    </Button>
  );
}
