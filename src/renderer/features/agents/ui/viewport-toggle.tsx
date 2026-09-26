import { Button } from '@benord-labs/frink-primitives';
import { Monitor, Smartphone } from 'lucide-react';
import { motion } from 'motion/react';
import { cn } from '../../../lib/utils';

type ViewportToggleProps = {
  value: 'desktop' | 'mobile';
  onChange: (mode: 'desktop' | 'mobile') => void;
  className?: string;
};

export function ViewportToggle({ value, onChange, className }: ViewportToggleProps) {
  return (
    <motion.div
      layout
      className={cn('flex items-center', className)}
      transition={{
        layout: {
          duration: 0.15,
          ease: 'easeInOut',
        },
      }}
    >
      <motion.div layout className="relative bg-muted rounded-lg h-7 p-0.5 flex">
        {/* Animated selector */}
        <motion.div
          className="absolute inset-y-0.5 rounded-md bg-background shadow-sm transition-all duration-200 ease-in-out"
          animate={{
            width: 'calc(50% - 2px)',
            left: value === 'desktop' ? '2px' : 'calc(50%)',
          }}
          transition={{
            duration: 0.2,
            ease: 'easeInOut',
          }}
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onChange('desktop');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              onChange('desktop');
            }
          }}
          aria-label="Desktop viewport"
          aria-pressed={value === 'desktop'}
          className={cn('relative z-2 px-2 flex-1 h-auto rounded-md duration-200')}
        >
          <Monitor className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onChange('mobile');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              onChange('mobile');
            }
          }}
          aria-label="Mobile viewport"
          aria-pressed={value === 'mobile'}
          className={cn('relative z-2 px-2 flex-1 h-auto rounded-md duration-200')}
        >
          <Smartphone className="h-3.5 w-3.5" />
        </Button>
      </motion.div>
    </motion.div>
  );
}
