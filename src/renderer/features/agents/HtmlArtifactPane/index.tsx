import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { HtmlArtifactData } from '../../../../shared/types/artifacts/html-artifact';

type HtmlArtifactPaneContextValue = {
  surfaceId: string;
  selection: HtmlArtifactData | null;
  isPaneActive: boolean;
  openArtifact: (artifact: HtmlArtifactData) => void;
  closeArtifact: () => void;
  closeIfSelected: (artifactId: string) => void;
};

const HtmlArtifactPaneContext = createContext<HtmlArtifactPaneContextValue | null>(null);

function focusArtifactTrigger(root: HTMLElement | null, artifactId: string): void {
  requestAnimationFrame(() => {
    const triggers = root?.querySelectorAll<HTMLElement>('[data-html-artifact-trigger]') ?? [];
    for (const trigger of triggers) {
      if (trigger.dataset.htmlArtifactTrigger === artifactId) {
        trigger.focus();
        return;
      }
    }
  });
}

export function HtmlArtifactPaneProvider({
  paneKey,
  isPaneActive,
  children,
}: {
  paneKey: string;
  isPaneActive: boolean;
  children: ReactNode;
}): ReactElement {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectionRef = useRef<HtmlArtifactData | null>(null);
  const [selection, setSelection] = useState<HtmlArtifactData | null>(null);

  const openArtifact = useCallback((artifact: HtmlArtifactData) => {
    selectionRef.current = artifact;
    setSelection(artifact);
  }, []);

  const closeArtifact = useCallback(() => {
    const artifactId = selectionRef.current?.artifactId;
    selectionRef.current = null;
    setSelection(null);
    if (artifactId) focusArtifactTrigger(rootRef.current, artifactId);
  }, []);

  const closeIfSelected = useCallback((artifactId: string) => {
    if (selectionRef.current?.artifactId !== artifactId) return;
    selectionRef.current = null;
    setSelection(null);
  }, []);

  const value = useMemo(
    () => ({
      surfaceId: `html-artifact:${paneKey}`,
      selection,
      isPaneActive,
      openArtifact,
      closeArtifact,
      closeIfSelected,
    }),
    [closeArtifact, closeIfSelected, isPaneActive, openArtifact, paneKey, selection],
  );

  return (
    <HtmlArtifactPaneContext.Provider value={value}>
      {/* No layout box: ChatView's root has no width of its own and sizes against its container. */}
      <div ref={rootRef} className="contents">
        {children}
      </div>
    </HtmlArtifactPaneContext.Provider>
  );
}

export function useHtmlArtifactPane(): HtmlArtifactPaneContextValue {
  const value = useContext(HtmlArtifactPaneContext);
  if (!value) throw new Error('HtmlArtifactPaneProvider is required');
  return value;
}
