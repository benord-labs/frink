/**
 * Manifest, entrypoint and folder affordances for a USER-AUTHORED custom node.
 *
 * Deliberately not rendered for plugin-spawned steps: those manifests are
 * machine-owned (decision `frink-integration-plugin`, 2026-08-18 Target), so
 * opening, editing or syncing one is meaningless to the person configuring it.
 */

import { Button } from '@benord-labs/frink-primitives';
import { useSetAtom } from 'jotai';
import type { LucideIcon } from 'lucide-react';
import { Code, FileCode2, FolderOpen, RefreshCw } from 'lucide-react';
import { type ReactElement, useMemo } from 'react';
import { toast } from 'sonner';
import { Badge } from '../../../../../../components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../../../../components/ui/tooltip';
import { trpc } from '../../../../../../lib/trpc';
import { openFileAtom } from '../../../../../code-editor';
import { BLOCK_CONFIG_SECTION_STACK_CLASS } from '../../block-config-chrome';

type LocalManifest = {
  nodePath?: string;
  entrypoint?: string;
  description?: string;
  version?: string;
  timeout?: number;
};

type CloudNodeType = {
  description?: string;
  version?: string;
  timeout?: number;
  entrypoint?: string;
};

type Props = {
  blockType: string;
  localManifest: LocalManifest | undefined;
  /** Cloud-side view of the same node; wins over the local manifest when present. */
  nodeType: CloudNodeType | undefined;
};

type ChromeAction = {
  label: string;
  icon: LucideIcon;
  hint: string;
  disabled: boolean;
  onClick: () => void;
};

/** The four affordances differ only in glyph, copy and handler — the shell is stated once. */
function ChromeButton({ label, icon: Icon, hint, disabled, onClick }: ChromeAction): ReactElement {
  return (
    <Tooltip delayDuration={250}>
      <TooltipTrigger asChild>
        {/* The trigger must stay enabled to keep the hint reachable on a disabled action. */}
        <span className="inline-flex">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-7 gap-1 text-xs"
            disabled={disabled}
            onClick={onClick}
          >
            <Icon className="h-3 w-3" aria-hidden />
            {label}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-xs">
        {hint}
      </TooltipContent>
    </Tooltip>
  );
}

/** First candidate with real text; every label here is a "cloud, else local, else dash" pick. */
function firstText(...candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

/** Cloud view wins over the local manifest; both may be absent while a node is undiscovered. */
function summariseManifest(
  nodeType: CloudNodeType | undefined,
  localManifest: LocalManifest | undefined,
): {
  descriptionText: string;
  descriptionMissing: boolean;
  versionLabel: string;
  timeoutLabel: string;
  entrypointLabel: string;
} {
  const cloud = nodeType ?? {};
  const local = localManifest ?? {};
  const timeout = cloud.timeout ?? local.timeout;
  return {
    descriptionText: firstText(cloud.description, local.description) ?? '',
    descriptionMissing: localManifest != null && !firstText(local.description),
    versionLabel: firstText(cloud.version, local.version) ?? '—',
    timeoutLabel: timeout != null ? String(timeout) : '—',
    entrypointLabel: firstText(cloud.entrypoint, local.entrypoint) ?? '—',
  };
}

type ChromeActionDeps = {
  openFile: (file: { path: string; name: string; language?: string; intent: 'preview' }) => void;
  openInFinder: { isPending: boolean; mutateAsync: (path: string) => Promise<unknown> };
  syncMutation: { isPending: boolean; mutate: () => void };
  localManifest: LocalManifest | undefined;
  manifestPath: string | null;
  entrypointPath: string | null;
};

/** Every affordance stays reachable when disabled — its hint explains why it is. */
function buildChromeActions({
  openFile,
  openInFinder,
  syncMutation,
  localManifest,
  manifestPath,
  entrypointPath,
}: ChromeActionDeps): ChromeAction[] {
  return [
    {
      label: 'Open entrypoint',
      icon: Code,
      disabled: !entrypointPath,
      hint: entrypointPath
        ? "Open the entrypoint script in Frink's editor."
        : 'No local node folder or entrypoint in the manifest yet.',
      onClick: () => {
        if (!entrypointPath) return;
        openFile({
          path: entrypointPath,
          name: entrypointPath.split('/').pop() ?? 'entrypoint',
          intent: 'preview',
        });
      },
    },
    {
      label: 'Open manifest',
      icon: FileCode2,
      disabled: !manifestPath,
      hint: manifestPath
        ? "Open manifest.json in Frink's editor."
        : 'Local manifest path is unknown until this node is discovered on disk.',
      onClick: () => {
        if (!manifestPath) return;
        openFile({
          path: manifestPath,
          name: 'manifest.json',
          language: 'json',
          intent: 'preview',
        });
      },
    },
    {
      label: 'Show in folder',
      icon: FolderOpen,
      disabled: !localManifest?.nodePath || openInFinder.isPending,
      hint: localManifest?.nodePath
        ? "Reveal this node's folder in Finder or File Explorer."
        : 'Local node folder not found.',
      onClick: () => {
        if (!localManifest?.nodePath) return;
        void openInFinder
          .mutateAsync(`${localManifest.nodePath}`)
          .catch(() => toast.error('Could not open folder'));
      },
    },
    {
      label: 'Sync to cloud',
      icon: RefreshCw,
      disabled: syncMutation.isPending,
      hint: 'Upload local definitions from ~/.frink/nodes so the cloud and this flow see the latest version.',
      onClick: () => syncMutation.mutate(),
    },
  ];
}

export function CustomNodeDeveloperDetails({
  blockType,
  localManifest,
  nodeType,
}: Props): ReactElement {
  const openFile = useSetAtom(openFileAtom);
  const utils = trpc.useUtils();
  const openInFinder = trpc.external.openInFinder.useMutation();
  const syncMutation = trpc.customNodes.sync.useMutation({
    onSuccess: (r) => {
      toast.success(`Synced ${r.synced} custom node(s)`);
      void utils.customNodes.invalidate();
    },
    onError: (e) => toast.error(e.message || 'Sync failed'),
  });

  const { data: health } = trpc.customNodes.health.useQuery(
    { nodeName: blockType },
    { enabled: blockType.length > 0, staleTime: 30_000 },
  );

  const { descriptionText, descriptionMissing, versionLabel, timeoutLabel, entrypointLabel } =
    summariseManifest(nodeType, localManifest);

  const healthErrors = health?.errors ?? [];
  const dedupedHealthWarnings = useMemo(() => {
    const flat = health?.manifestWarnings?.flatMap((e) => e.warnings) ?? [];
    return Array.from(new Set(flat));
  }, [health?.manifestWarnings]);
  const hasHealthProblems = healthErrors.length > 0 || dedupedHealthWarnings.length > 0;

  const manifestPath =
    localManifest?.nodePath != null ? `${localManifest.nodePath}/manifest.json` : null;
  const entrypointPath =
    localManifest?.nodePath != null && localManifest.entrypoint
      ? `${localManifest.nodePath}/${localManifest.entrypoint}`
      : null;

  const actions = buildChromeActions({
    openFile,
    openInFinder,
    syncMutation,
    localManifest,
    manifestPath,
    entrypointPath,
  });

  return (
    <>
      <div className={BLOCK_CONFIG_SECTION_STACK_CLASS}>
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-foreground">Node details</p>
          <div className="flex flex-wrap items-center gap-1">
            <Badge variant="outline" className="text-[10px] font-normal">
              v{versionLabel}
            </Badge>
            <Badge variant="outline" className="text-[10px] font-normal">
              {timeoutLabel}s timeout
            </Badge>
          </div>
        </div>
        {descriptionMissing ? (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-800 dark:text-amber-300">
            No description in manifest — add <span className="font-mono">description</span> for
            better editor UX.
          </p>
        ) : null}
        {descriptionText ? (
          <p className="text-xs leading-snug text-muted-foreground">{descriptionText}</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
          <span className="shrink-0">Entrypoint:</span>
          <code className="truncate rounded bg-background/80 px-1 py-0.5 font-mono text-[10px]">
            {entrypointLabel}
          </code>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {actions.map((action) => (
            <ChromeButton key={action.label} {...action} />
          ))}
        </div>
      </div>

      {hasHealthProblems ? (
        <div
          className="rounded-md border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200"
          role="alert"
        >
          <p className="font-medium text-amber-950 dark:text-amber-100">
            Local folder needs attention
          </p>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
            {healthErrors.map((e) => (
              <li key={`${e.dir}-${e.error}`}>
                <span className="font-mono">{e.dir}</span>: {e.error}
              </li>
            ))}
            {dedupedHealthWarnings.map((w) => (
              <li key={`${blockType}-${w}`}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}
