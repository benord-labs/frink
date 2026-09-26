/**
 * Wraps pane content with CSS zoom when zoomFactor !== 1.
 * Uses the `zoom` property (Chromium) for layout-aware scaling. Single place for zoom style/behavior.
 */
export function ZoomWrapper({
  zoomFactor = 1,
  className,
  children,
}: {
  zoomFactor?: number;
  className?: string;
  children: React.ReactNode;
}): React.ReactElement {
  const style = {
    '--pane-zoom-factor': zoomFactor,
    ...(zoomFactor !== 1
      ? {
          width: '100%',
          height: '100%',
          minHeight: '100%',
          overflow: 'visible',
          // TS CSSProperties does not type `zoom` in all setups.
          // biome-ignore lint/suspicious/noExplicitAny: Chromium zoom for layout-aware scaling
          ...({ zoom: zoomFactor } as any),
        }
      : {}),
  } as React.CSSProperties;
  return (
    <div style={style} className={className}>
      {children}
    </div>
  );
}
