import { Button } from '@benord-labs/frink-primitives';
import * as Sentry from '@sentry/electron/renderer';
import { TRPCClientError } from '@trpc/client';
import { Import } from 'lucide-react';
import { type ReactElement, useRef, useState } from 'react';
import { toast } from 'sonner';
import { MAX_FLOW_FILE_BYTES } from '../../../../../shared/lib/flows/flow-file';
import { trpcClient } from '../../../../lib/trpc';

type ImportedFlow = { id: string; name: string; needsSetup: string[] };
type ImportFile = (contents: string) => Promise<ImportedFlow>;

type ImportFlowButtonProps = {
  onImported: (id: string) => void;
  /** Sends the file text to be saved as a new flow; tests pass a fake. */
  importFile?: ImportFile;
};

function sendFlowFile(contents: string): Promise<ImportedFlow> {
  return trpcClient.flows.importFile.mutate({ contents });
}

function importedDescription(needsSetup: readonly string[]): string {
  const off = "It's turned off until you turn it on.";
  return needsSetup.length > 0 ? `${off} First finish setting up: ${needsSetup.join(', ')}.` : off;
}

async function importFlowFile(
  file: File,
  importFile: ImportFile,
  onImported: (id: string) => void,
): Promise<void> {
  if (file.size > MAX_FLOW_FILE_BYTES) {
    toast.error('This file is too big to be a Frink flow.');
    return;
  }
  try {
    const flow = await importFile(await file.text());
    onImported(flow.id);
    toast.success(`Imported “${flow.name}”`, {
      description: importedDescription(flow.needsSetup),
      duration: flow.needsSetup.length > 0 ? 10_000 : undefined,
    });
  } catch (error) {
    // A file the user picked that isn't a usable flow is expected, not a bug worth reporting.
    if (!(error instanceof TRPCClientError && error.data?.code === 'BAD_REQUEST')) {
      Sentry.captureException(error, { tags: { source: 'ImportFlowButton', action: 'import' } });
    }
    toast.error(error instanceof Error && error.message ? error.message : 'Could not import flow');
  }
}

/** Opens a flow file saved by "Export file", on this computer or another one. */
export function ImportFlowButton({
  onImported,
  importFile = sendFlowFile,
}: ImportFlowButtonProps): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        <Import className="size-3.5" aria-hidden />
        Import flow
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept=".json,application/json"
        hidden
        aria-label="Flow file"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (!file) return;
          setBusy(true);
          void importFlowFile(file, importFile, onImported).finally(() => setBusy(false));
        }}
      />
    </>
  );
}
