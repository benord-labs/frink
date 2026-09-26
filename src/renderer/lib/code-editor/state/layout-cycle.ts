export type CodeEditorLayout = 'top' | 'left' | 'right';
export type LegacyCodeEditorLayout = 'vertical' | 'horizontal';

const LAYOUT_CYCLE: CodeEditorLayout[] = ['top', 'left', 'right'];

export function normalizeCodeEditorLayout(layout: string | null | undefined): CodeEditorLayout {
  if (layout === 'left' || layout === 'right' || layout === 'top') return layout;
  if (layout === 'vertical') return 'top';
  if (layout === 'horizontal') return 'left';
  return 'top';
}

export function getNextCodeEditorLayout(layout: CodeEditorLayout): CodeEditorLayout {
  const currentIndex = LAYOUT_CYCLE.indexOf(layout);
  const nextIndex = (currentIndex + 1) % LAYOUT_CYCLE.length;
  return LAYOUT_CYCLE[nextIndex];
}

export function getNextCodeEditorLayoutFromUnknown(
  layout: string | null | undefined,
): CodeEditorLayout {
  return getNextCodeEditorLayout(normalizeCodeEditorLayout(layout));
}
