import { useEffect, useRef, useState } from 'react';

type UseAnimationLogicProps = {
  isOpen: boolean;
  animationDuration: number;
};

type UseAnimationLogicReturn = {
  shouldAnimate: boolean;
  setShouldAnimate: (animate: boolean) => void;
};

export function useAnimationLogic({
  isOpen,
  animationDuration,
}: UseAnimationLogicProps): UseAnimationLogicReturn {
  const hasOpenedOnce = useRef(false);
  const wasOpenRef = useRef(false);
  const [shouldAnimate, setShouldAnimate] = useState(!isOpen);

  useEffect(() => {
    // Reset animation when sidebar closes
    if (!isOpen && wasOpenRef.current) {
      hasOpenedOnce.current = false;
      setShouldAnimate(true);
    }

    wasOpenRef.current = isOpen;

    // Mark as opened after animation completes
    if (isOpen && !hasOpenedOnce.current) {
      const timer = setTimeout(
        () => {
          hasOpenedOnce.current = true;
          setShouldAnimate(false);
        },
        animationDuration * 1000 + 50,
      );

      return () => clearTimeout(timer);
    }

    if (isOpen && hasOpenedOnce.current) {
      setShouldAnimate(false);
    }
  }, [isOpen, animationDuration]);

  return {
    shouldAnimate,
    setShouldAnimate,
  };
}
