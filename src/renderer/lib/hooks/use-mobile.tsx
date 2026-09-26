import * as React from 'react';

// Breakpoint for narrow/mobile layout in desktop app
const NARROW_BREAKPOINT = 600;

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean>(() => {
    // Initialize immediately in Electron (no SSR concerns)
    return typeof window !== 'undefined' && window.innerWidth < NARROW_BREAKPOINT;
  });

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${NARROW_BREAKPOINT - 1}px)`);
    const onChange = () => {
      setIsMobile(window.innerWidth < NARROW_BREAKPOINT);
    };
    mql.addEventListener('change', onChange);
    setIsMobile(window.innerWidth < NARROW_BREAKPOINT);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return isMobile;
}
