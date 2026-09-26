import { Button } from '@benord-labs/frink-primitives';
import { AppWindow } from 'lucide-react';
import { type ReactElement, useEffect } from 'react';
import { LAUNCH_FLAGS } from '../../../../shared/launch-flags';
import type { HtmlArtifactData } from '../../../../shared/types/artifacts/html-artifact';
import { useHtmlArtifactPane } from '../HtmlArtifactPane';
import { HtmlArtifactPreview } from '../HtmlArtifactPreview';

type Props = { artifact: HtmlArtifactData };

export function HtmlArtifactCard({ artifact }: Props): ReactElement {
  const { selection, openArtifact, closeIfSelected } = useHtmlArtifactPane();

  useEffect(
    () => () => closeIfSelected(artifact.artifactId),
    [artifact.artifactId, closeIfSelected],
  );

  if (!LAUNCH_FLAGS.flowHtmlArtifacts) {
    return (
      <p className="my-2 text-sm text-muted-foreground">
        {artifact.title} — interactive results are turned off.
      </p>
    );
  }

  if (selection?.artifactId === artifact.artifactId) return <HtmlArtifactPreview />;

  return (
    <section
      className="my-2 border-y border-border py-2"
      aria-label={`Interactive result: ${artifact.title}`}
    >
      <div className="flex min-h-11 items-center gap-2.5 px-1">
        <AppWindow className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{artifact.title}</p>
          <p className="text-xs text-muted-foreground">Interactive result</p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="xs"
          onClick={() => openArtifact(artifact)}
          data-html-artifact-trigger={artifact.artifactId}
        >
          Run artifact
        </Button>
      </div>
    </section>
  );
}
