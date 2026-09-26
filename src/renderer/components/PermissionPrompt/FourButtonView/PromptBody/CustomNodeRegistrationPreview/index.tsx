import { type Change, diffLines } from 'diff';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { memo, type ReactElement, useId, useMemo, useState } from 'react';
import type {
  CustomNodeRegistrationPresentation,
  CustomNodeResourceChange,
} from '../../../../../../shared/types/permissions';
import { cn } from '../../../../../lib/utils';

type Props = {
  presentation: CustomNodeRegistrationPresentation;
};

type SourceLine = {
  key: string;
  prefix: ' ' | '+' | '-';
  status: 'Added' | 'Removed' | 'Unchanged';
  text: string;
};

const COLLAPSED_SOURCE_LINE_COUNT = 6;
const SECURITY_CONTROL_NAMES = new Map([
  [9, 'TAB'],
  [10, 'LF'],
  [13, 'CR'],
  [27, 'ESC'],
  [1564, 'ALM'],
  [8206, 'LRM'],
  [8207, 'RLM'],
  [8234, 'LRE'],
  [8235, 'RLE'],
  [8236, 'PDF'],
  [8237, 'LRO'],
  [8238, 'RLO'],
  [8294, 'LRI'],
  [8295, 'RLI'],
  [8296, 'FSI'],
  [8297, 'PDI'],
]);

const RESOURCE_CHANGE_STYLES = {
  added: 'border-status-online/40 bg-status-online/15 text-foreground',
  changed: 'border-status-warning/40 bg-status-warning/15 text-foreground',
  removed: 'border-destructive/40 bg-destructive/10 text-foreground',
  unchanged: 'border-border bg-muted text-muted-foreground',
} satisfies Record<CustomNodeResourceChange, string>;

function visibleSecurityText(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    const name = SECURITY_CONTROL_NAMES.get(codePoint);
    const isControl = codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
    if (!name && !isControl) return character;
    return `⟦${name ?? 'CONTROL'} U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}⟧`;
  }).join('');
}

function visibleMultilineSecurityText(value: string): string {
  return value
    .split('\n')
    .map((line) => visibleSecurityText(line))
    .join('\n');
}

function IsolatedText({ value }: { value: string }): ReactElement {
  return <bdi dir="auto">{visibleSecurityText(value)}</bdi>;
}

function sourceStatus(
  change: Partial<Pick<Change, 'added' | 'removed'>>,
): Pick<SourceLine, 'prefix' | 'status'> {
  if (change.added) return { prefix: '+', status: 'Added' };
  if (change.removed) return { prefix: '-', status: 'Removed' };
  return { prefix: ' ', status: 'Unchanged' };
}

function sourceLines(current: string, previous?: string): SourceLine[] {
  const changes =
    previous === undefined ? [{ added: true, value: current }] : diffLines(previous, current);
  let index = 0;

  return changes.flatMap((change) => {
    const { prefix, status } = sourceStatus(change);
    const lines = change.value.endsWith('\n')
      ? change.value.slice(0, -1).split('\n')
      : change.value.split('\n');
    return lines.map((text) => ({
      key: `${index++}`,
      prefix,
      status,
      text: visibleSecurityText(text),
    }));
  });
}

function SourcePreview({
  current,
  previous,
  label,
  path,
}: {
  current: string;
  previous?: string;
  label: string;
  path: string;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const sourceId = useId();
  const lines = useMemo(() => sourceLines(current, previous), [current, previous]);
  const isUpdate = previous !== undefined;
  const canExpand = lines.length > COLLAPSED_SOURCE_LINE_COUNT;
  const visibleLines = expanded ? lines : lines.slice(0, COLLAPSED_SOURCE_LINE_COUNT);
  const hiddenLineCount = lines.length - visibleLines.length;

  return (
    <section className="space-y-1" aria-labelledby={`${sourceId}-label`}>
      <div className="flex items-center justify-between gap-2">
        <span id={`${sourceId}-label`} className="text-[10px] font-medium text-muted-foreground">
          {isUpdate ? `${label} changes` : `${label} source`} · <IsolatedText value={path} />
        </span>
        {canExpand ? (
          <button
            type="button"
            className="inline-flex min-h-7 items-center gap-1 rounded px-1.5 text-[10px] font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-expanded={expanded}
            aria-controls={sourceId}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? 'Collapse source' : 'Expand source'}
            {expanded ? (
              <ChevronUp className="size-3" aria-hidden="true" />
            ) : (
              <ChevronDown className="size-3" aria-hidden="true" />
            )}
          </button>
        ) : null}
      </div>
      <pre
        id={sourceId}
        dir="ltr"
        className={cn(
          'overflow-auto rounded border border-border bg-muted/40 font-mono text-[10px] leading-4',
          expanded ? 'max-h-80' : 'max-h-24',
        )}
      >
        {visibleLines.map((line) => (
          <code
            key={line.key}
            className={cn(
              'block min-w-max px-2',
              line.status === 'Added' && 'bg-status-online/10 text-foreground',
              line.status === 'Removed' && 'bg-destructive/10 text-foreground',
              line.status === 'Unchanged' && 'text-muted-foreground',
            )}
          >
            <span className="sr-only">{line.status}: </span>
            <span aria-hidden="true">{line.prefix} </span>
            <bdi dir="auto">{line.text || ' '}</bdi>
          </code>
        ))}
        {hiddenLineCount > 0 ? (
          <span className="sr-only">{hiddenLineCount} more source lines hidden.</span>
        ) : null}
      </pre>
    </section>
  );
}

function ResourceList({
  resources,
}: Pick<CustomNodeRegistrationPresentation, 'resources'>): ReactElement {
  return (
    <section className="space-y-1">
      <span className="text-[10px] font-medium text-muted-foreground">Package resources</span>
      {resources.length === 0 ? (
        <p className="text-[10px] text-muted-foreground">No colocated resources</p>
      ) : (
        <ul className="space-y-1">
          {resources.map((resource) => (
            <li
              key={resource.path}
              className="flex min-w-0 items-center justify-between gap-2 text-[10px]"
            >
              <code className="min-w-0 flex-1 truncate font-mono text-foreground">
                <IsolatedText value={resource.path} />
              </code>
              <span className="shrink-0 text-muted-foreground">
                {resource.bytes.toLocaleString()} bytes
              </span>
              <span
                className={cn(
                  'shrink-0 rounded border px-1 py-0.5 font-medium capitalize',
                  RESOURCE_CHANGE_STYLES[resource.change],
                )}
              >
                {resource.change}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export const CustomNodeRegistrationPreview = memo(function CustomNodeRegistrationPreview({
  presentation,
}: Props): ReactElement {
  const { node } = presentation;
  const title = node.displayName?.trim() || node.name;

  return (
    <article className="min-w-0 space-y-2 [overflow-wrap:anywhere]">
      <div className="space-y-0.5">
        <strong className="block text-xs font-semibold text-foreground">
          {presentation.action === 'create' ? 'Register' : 'Replace'} “
          <IsolatedText value={title} />
          ”?
        </strong>
        <p className="text-[10px] text-muted-foreground">
          Node{' '}
          <code className="font-mono text-foreground">
            <IsolatedText value={node.name} />
          </code>{' '}
          from{' '}
          {presentation.packagePath === undefined ? (
            'inline script'
          ) : (
            <code className="font-mono text-foreground">
              <IsolatedText value={presentation.packagePath} />
            </code>
          )}
        </p>
        {node.description ? (
          <p className="text-[10px] text-foreground">
            <IsolatedText value={node.description} />
          </p>
        ) : null}
      </div>

      <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px]">
        <dt className="text-muted-foreground">Version</dt>
        <dd className="text-foreground">
          {node.version ? <IsolatedText value={node.version} /> : 'Not specified'}
        </dd>
        <dt className="text-muted-foreground">Snapshot</dt>
        <dd className="break-all font-mono text-foreground">{presentation.packageDigest}</dd>
        <dt className="text-muted-foreground">Package size</dt>
        <dd className="text-foreground">{presentation.packageBytes.toLocaleString()} bytes</dd>
      </dl>

      <SourcePreview
        current={presentation.source.current}
        previous={presentation.source.previous}
        label="Entrypoint"
        path={node.entrypoint}
      />
      {presentation.modules.map((module) => (
        <SourcePreview
          key={module.path}
          current={module.current}
          previous={module.previous}
          label="Module"
          path={module.path}
        />
      ))}
      <ResourceList resources={presentation.resources} />

      <section className="space-y-0.5 text-[10px]">
        <p>
          <span className="text-muted-foreground">Requested credentials: </span>
          <span className="text-foreground">
            {presentation.credentialNames.length > 0 ? (
              <IsolatedText value={presentation.credentialNames.join(', ')} />
            ) : (
              'None'
            )}
          </span>
        </p>
        {presentation.test ? (
          <>
            <p className="text-muted-foreground">
              Registration test · timeout {presentation.test.timeoutMs.toLocaleString()} ms
            </p>
            <pre
              dir="ltr"
              className="max-h-24 overflow-auto rounded border border-border bg-muted/40 px-2 py-1 font-mono text-foreground whitespace-pre-wrap"
            >
              {visibleMultilineSecurityText(JSON.stringify(presentation.test.config, null, 2))}
            </pre>
          </>
        ) : (
          <p className="text-muted-foreground">No registration test requested</p>
        )}
      </section>

      <p className="rounded border border-status-warning/40 bg-status-warning/15 px-2 py-1 text-[10px] leading-4 text-foreground">
        <strong>Warning: </strong>
        {presentation.replacesPackage
          ? 'This replaces a folder-installed node — the modules and data files listed as removed will be deleted. '
          : null}
        <IsolatedText value={presentation.warning} />
      </p>
    </article>
  );
});
