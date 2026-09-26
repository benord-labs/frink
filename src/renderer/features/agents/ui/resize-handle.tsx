import { motion } from 'motion/react';
import { cn } from '../../../lib/utils';

type ResizeHandleProps = {
  side: 'left' | 'right';
  onPointerDown: (e: React.PointerEvent) => void;
  isResizing?: boolean;
  className?: string;
};

export function ResizeHandle({
  side,
  onPointerDown,
  isResizing = false,
  className,
}: ResizeHandleProps) {
  return (
    <motion.div
      data-side={side}
      onPointerDown={onPointerDown}
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 12, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{
        duration: 0.3,
        ease: 'easeInOut',
      }}
      className={cn(
        'h-16 bg-muted-foreground/20 rounded-full cursor-ew-resize hover:bg-muted-foreground/40 transition-colors shrink-0 pointer-events-auto select-none touch-none',
        isResizing && 'bg-muted-foreground/60',
        className,
      )}
      style={{ touchAction: 'none' }}
    />
  );
}
