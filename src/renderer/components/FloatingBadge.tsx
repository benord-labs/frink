import { memo, useEffect, useRef, useState } from 'react';
import { FrinkLogo } from '@/features/sidebar/unified/components/SidebarHeader/FrinkLogo';

const SPEED = 1.5;
/** Bouncing logo size in CSS px; exported for tests that assert viewport clamping. */
export const LOGO_W = 120;
export const LOGO_H = 45;

const DVD_HUES = [228, 0, 30, 60, 120, 180, 280, 320];

export const FloatingBadge = memo(function FloatingBadge({ onDismiss }: { onDismiss: () => void }) {
  const logoRef = useRef<HTMLDivElement>(null);
  const posRef = useRef({
    x: Math.random() * Math.max(0, window.innerWidth - LOGO_W),
    y: Math.random() * Math.max(0, window.innerHeight - LOGO_H),
  });
  const velRef = useRef({
    x: SPEED * (Math.random() > 0.5 ? 1 : -1),
    y: SPEED * (Math.random() > 0.5 ? 1 : -1) * (0.7 + Math.random() * 0.6),
  });
  const hueIdxRef = useRef(0);
  const cornerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cornerKeyRef = useRef(0);
  const [hueIdx, setHueIdx] = useState(0);
  const [cornerKey, setCornerKey] = useState(0);

  useEffect(() => {
    let animId: number;

    const animate = () => {
      const pos = posRef.current;
      const vel = velRef.current;
      const el = logoRef.current;

      if (!el) {
        animId = requestAnimationFrame(animate);
        return;
      }

      const w = window.innerWidth;
      const h = window.innerHeight;

      pos.x += vel.x;
      pos.y += vel.y;

      let hitX = false;
      let hitY = false;

      if (pos.x <= 0) {
        vel.x = Math.abs(vel.x);
        pos.x = 0;
        hitX = true;
      } else if (pos.x >= w - LOGO_W) {
        vel.x = -Math.abs(vel.x);
        pos.x = w - LOGO_W;
        hitX = true;
      }

      if (pos.y <= 0) {
        vel.y = Math.abs(vel.y);
        pos.y = 0;
        hitY = true;
      } else if (pos.y >= h - LOGO_H) {
        vel.y = -Math.abs(vel.y);
        pos.y = h - LOGO_H;
        hitY = true;
      }

      if (hitX || hitY) {
        hueIdxRef.current = (hueIdxRef.current + 1) % DVD_HUES.length;
        setHueIdx(hueIdxRef.current);
      }

      if (hitX && hitY) {
        cornerKeyRef.current += 1;
        setCornerKey(cornerKeyRef.current);
        if (cornerTimerRef.current) clearTimeout(cornerTimerRef.current);
        cornerTimerRef.current = setTimeout(() => {
          setCornerKey(0);
          cornerTimerRef.current = null;
        }, 1200);
      }

      el.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
      animId = requestAnimationFrame(animate);
    };

    /** Shrink/grow: keep `posRef` in-bounds and align `velRef` with edges (same invariants as `animate`). */
    const onWindowResize = () => {
      const pos = posRef.current;
      const vel = velRef.current;
      const el = logoRef.current;
      if (!el) return;
      const w = window.innerWidth;
      const h = window.innerHeight;
      const maxX = Math.max(0, w - LOGO_W);
      const maxY = Math.max(0, h - LOGO_H);
      pos.x = Math.min(Math.max(0, pos.x), maxX);
      pos.y = Math.min(Math.max(0, pos.y), maxY);
      if (maxX === 0) vel.x = 0;
      else {
        if (pos.x === 0) vel.x = Math.abs(vel.x);
        else if (pos.x === maxX) vel.x = -Math.abs(vel.x);
      }
      if (maxY === 0) vel.y = 0;
      else {
        if (pos.y === 0) vel.y = Math.abs(vel.y);
        else if (pos.y === maxY) vel.y = -Math.abs(vel.y);
      }
      el.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
    };

    window.addEventListener('resize', onWindowResize);
    animId = requestAnimationFrame(animate);
    return () => {
      window.removeEventListener('resize', onWindowResize);
      cancelAnimationFrame(animId);
      if (cornerTimerRef.current) clearTimeout(cornerTimerRef.current);
    };
  }, []);

  useEffect(() => {
    window.addEventListener('mousedown', onDismiss);
    window.addEventListener('keydown', onDismiss);
    return () => {
      window.removeEventListener('mousedown', onDismiss);
      window.removeEventListener('keydown', onDismiss);
    };
  }, [onDismiss]);

  const hue = DVD_HUES[hueIdx];

  return (
    <div className="fixed inset-0 z-9998 bg-black ee-dvd-fade-in cursor-pointer">
      {cornerKey > 0 && (
        <div key={cornerKey} className="absolute inset-0 ee-dvd-corner-flash pointer-events-none" />
      )}
      <div
        ref={logoRef}
        data-testid="ee-floating-badge-layer"
        className="absolute top-0 left-0 will-change-transform"
        style={
          {
            '--primary': `${hue} 100% 60%`,
            color: `hsl(${hue} 100% 70%)`,
          } as React.CSSProperties
        }
      >
        <FrinkLogo className="h-12 w-auto" />
      </div>
    </div>
  );
});
