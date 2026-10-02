import {
  type ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useSetAtom } from 'jotai';
import { createPortal } from 'react-dom';
import { floatingBadgeActiveAtom } from '@/hooks/use-easter-eggs';
import { useLogoDodge } from '@/hooks/use-logo-dodge';
import { SidebarHeaderWithSearch } from '../../../components/SidebarHeaderWithSearch';
import { SIDEBAR_PANEL_SEARCH_INPUT_CLASS } from '../../../panel-search-input-class';
import { STRINGS } from '../../constants';
import { FrinkLogo } from './FrinkLogo';

/** Padding from viewport edge so the dodging logo stays fully visible. */
const VIEWPORT_PADDING = 8;

/** Holding the logo this long (without it dodging) starts the floating badge. */
const LONG_PRESS_MS = 3500;

type SidebarHeaderProps = {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  /** Archive mode scopes the search to archived chats; the placeholder says so. */
  showArchived: boolean;
  onToggleSidebar?: () => void;
};

type HomeRect = { left: number; top: number; width: number; height: number };

function clampToViewport(targetLeft: number, targetTop: number, w: number, h: number) {
  const minX = VIEWPORT_PADDING;
  const maxX = window.innerWidth - w - VIEWPORT_PADDING;
  const minY = VIEWPORT_PADDING;
  const maxY = window.innerHeight - h - VIEWPORT_PADDING;
  return {
    left: Math.max(minX, Math.min(maxX, targetLeft)),
    top: Math.max(minY, Math.min(maxY, targetTop)),
  };
}

export function SidebarHeader({
  searchQuery,
  onSearchChange,
  searchInputRef,
  showArchived,
  onToggleSidebar,
}: SidebarHeaderProps): ReactElement {
  const setFloatingBadgeActive = useSetAtom(floatingBadgeActiveAtom);

  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const homeRef = useRef<HTMLDivElement>(null);
  const [homeRect, setHomeRect] = useState<HomeRect | null>(null);
  const phaseRef = useRef<'idle' | 'active'>('idle');

  const { offset, phase, handlePointerDown: registerDodgePointerDown } = useLogoDodge(homeRef);
  phaseRef.current = phase;

  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (phase !== 'active') return;
    cancelLongPress();
  }, [phase, cancelLongPress]);

  useLayoutEffect(() => {
    if (!homeRef.current) return;
    const update = () => {
      const r = homeRef.current?.getBoundingClientRect();
      if (!r) return;
      setHomeRect((prev) => {
        if (
          prev &&
          prev.left === r.left &&
          prev.top === r.top &&
          prev.width === r.width &&
          prev.height === r.height
        ) {
          return prev;
        }
        return { left: r.left, top: r.top, width: r.width, height: r.height };
      });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(homeRef.current);
    ro.observe(document.body);
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);

  useEffect(() => {
    return () => {
      cancelLongPress();
    };
  }, [cancelLongPress]);

  const handleLogoPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // happy-dom / older browsers may not support pointer capture
      }

      cancelLongPress();

      if (phaseRef.current === 'idle') {
        longPressTimerRef.current = setTimeout(() => {
          longPressTimerRef.current = null;
          setFloatingBadgeActive(true);
        }, LONG_PRESS_MS);
      }

      registerDodgePointerDown();
    },
    [registerDodgePointerDown, setFloatingBadgeActive, cancelLongPress],
  );

  const handleLogoPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      cancelLongPress();
    },
    [cancelLongPress],
  );

  const handleLogoClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
  }, []);

  const isDodging = offset.x !== 0 || offset.y !== 0;
  const portalPos =
    isDodging && homeRect
      ? clampToViewport(
          homeRect.left + offset.x,
          homeRect.top + offset.y,
          homeRect.width,
          homeRect.height,
        )
      : null;

  return (
    <SidebarHeaderWithSearch
      title=""
      titleIcon={
        <div className="relative overflow-visible">
          {/* biome-ignore lint/a11y/noStaticElementInteractions: hidden easter-egg surface; deliberately not focusable. */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: hidden easter-egg surface; keyboard activation would expose it. */}
          <div
            ref={homeRef}
            className="will-change-transform p-2 -m-2"
            style={{
              visibility: portalPos ? 'hidden' : 'visible',
            }}
            onPointerDown={handleLogoPointerDown}
            onPointerUp={handleLogoPointerUp}
            onPointerLeave={handleLogoPointerUp}
            onPointerCancel={handleLogoPointerUp}
            onClick={handleLogoClick}
          >
            <FrinkLogo className="h-7 w-auto text-foreground" />
          </div>

          {portalPos &&
            createPortal(
              <>
                {/* biome-ignore lint/a11y/noStaticElementInteractions: hidden easter-egg surface; deliberately not focusable. */}
                {/* biome-ignore lint/a11y/useKeyWithClickEvents: hidden easter-egg surface; keyboard activation would expose it. */}
                <div
                  className="fixed pointer-events-auto will-change-transform transition-[left,top] duration-300 ease-out z-10000 px-3 py-2 rounded-full backdrop-blur-md bg-background/40 ring-1 ring-border/40 shadow-lg"
                  style={{
                    left: `${portalPos.left - 12}px`,
                    top: `${portalPos.top - 8}px`,
                  }}
                  onPointerDown={handleLogoPointerDown}
                  onPointerUp={handleLogoPointerUp}
                  onPointerLeave={handleLogoPointerUp}
                  onPointerCancel={handleLogoPointerUp}
                  onClick={handleLogoClick}
                >
                  <FrinkLogo className="h-7 w-auto text-foreground" />
                </div>
              </>,
              document.body,
            )}
        </div>
      }
      searchPlaceholder={
        showArchived ? STRINGS.SEARCH_ARCHIVED_PLACEHOLDER : STRINGS.SEARCH_PLACEHOLDER
      }
      searchQuery={searchQuery}
      onSearchChange={onSearchChange}
      searchInputRef={searchInputRef}
      onClose={onToggleSidebar}
      closeTooltipLabel={STRINGS.CLOSE_SIDEBAR}
      closeShortcutId="toggle-sidebar"
      searchInputClassName={SIDEBAR_PANEL_SEARCH_INPUT_CLASS}
      className="pt-6"
    />
  );
}
