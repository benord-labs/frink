import type { ReactElement } from 'react';
import type { FlowOutlineTerminal } from '../../../../../lib/flows/flow-change-outline';
import { ChangeDetails } from '../ChangeDetails';

function omissionText(count: number, anchor: string): string {
  return `${count} more ${count === 1 ? 'step' : 'steps'} ${count === 1 ? 'continues' : 'continue'} after ${anchor}`;
}

export function Omission({
  anchor,
  count,
}: {
  anchor: string;
  count?: number;
}): ReactElement | null {
  if (!count) return null;
  return (
    <p className="my-0.5 ml-[18px] text-[10px] italic leading-[14px] text-muted-foreground wrap-anywhere">
      {omissionText(count, anchor)}
    </p>
  );
}

export function RouteTerminal({
  terminal,
}: {
  terminal?: FlowOutlineTerminal;
}): ReactElement | null {
  if (!terminal) return null;
  return (
    <div className="my-0.5 ml-[18px] grid min-w-0 grid-cols-[10px_minmax(0,1fr)] items-baseline gap-x-[7px] text-[10px] leading-[14px] text-muted-foreground wrap-anywhere">
      <span aria-hidden="true">↳</span>
      <span>
        {terminal.relationLabel ? `${terminal.relationLabel}: ` : ''}
        {terminal.text}
      </span>
      <div className="col-start-2">
        <ChangeDetails changes={terminal.changes} />
      </div>
    </div>
  );
}
