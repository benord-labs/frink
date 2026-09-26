import { Button, Input, Textarea } from '@benord-labs/frink-primitives';
import { useIsMutating } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { toast } from 'sonner';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { Label } from '@/components/ui/label';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { isWindows } from '@/lib/utils/platform';
import {
  checkWorktreeBasePath,
  worktreeBasePathErrorMessage,
} from '../../../../../../shared/lib/worktree-base-path-rules';

const COMMANDS_LABEL_ID = 'project-worktree-commands';
const COMMANDS_HINT_ID = 'project-worktree-commands-hint';
const LOCATION_ID = 'project-worktree-location';
const LOCATION_HINT_ID = 'project-worktree-location-hint';
const LOCATION_ERROR_ID = 'project-worktree-location-error';

/** The editable fields, as the user typed them. */
type Fields = { commands: string[]; location: string };

const EMPTY_FIELDS: Fields = { commands: [], location: '' };

/** The fields as the router stores them; an empty value removes its key. */
type SavedFields = { 'setup-worktree': string[]; 'worktree-base-path': string };

function toSaved({ commands, location }: Fields): SavedFields {
  return {
    'setup-worktree': commands.map((command) => command.trim()).filter(Boolean),
    'worktree-base-path': location.trim(),
  };
}

// Only fields that differ from the file are sent (never a location the check refuses); the router
// merges them into the file as it is now, so another writer's edit to the other field survives.
function buildPatch(
  current: Fields,
  previous: SavedFields | null,
  locationValid: boolean,
): Partial<SavedFields> {
  const next = toSaved(current);
  const patch: Partial<SavedFields> = {};
  if (JSON.stringify(next['setup-worktree']) !== JSON.stringify(previous?.['setup-worktree'])) {
    patch['setup-worktree'] = next['setup-worktree'];
  }
  if (locationValid && next['worktree-base-path'] !== previous?.['worktree-base-path']) {
    patch['worktree-base-path'] = next['worktree-base-path'];
  }
  return patch;
}

function saveStatusText(status: 'idle' | 'pending' | 'success' | 'error'): string {
  if (status === 'pending') return 'Saving…';
  if (status === 'error') return "Couldn't save your last change.";
  return 'Changes save automatically to .frink/worktrees.json in this project.';
}

type Props = {
  projectId: string;
};

export function ProjectWorktreeSettings({ projectId }: Props) {
  const utils = trpc.useUtils();
  // Always refetch: the file can also be written by an agent or by hand, and the form is seeded
  // only once, so seeding from a cached copy would autosave stale commands over new ones.
  const configQuery = trpc.worktreeConfig.get.useQuery({ projectId }, { refetchOnMount: 'always' });
  const saveScope = `worktree-config:${projectId}`;
  const savesInFlight = useIsMutating({ predicate: (m) => m.options.scope?.id === saveScope });
  const { data: globalBasePath } = trpc.claudeSettings.getWorktreeBasePath.useQuery();
  const { data: homeDir } = trpc.external.getHomePath.useQuery(undefined, { staleTime: 300_000 });
  const saveMutation = trpc.worktreeConfig.save.useMutation({
    // Saves for one project land in order, each merged into the file as it is then.
    scope: { id: saveScope },
    // A save queued behind one that failed can succeed without the failed edit; resend it all.
    onSuccess: () => lastSent.current === null && save(),
    onError: (err) => {
      // The file's contents are unknown after a failure, so the next save resends every field.
      lastSent.current = null;
      toast.error(`Couldn't save worktree settings: ${err.message}`);
    },
    // Returned so the save stays in flight until the refetch lands (see `loaded` below).
    onSettled: () => utils.worktreeConfig.get.invalidate({ projectId }),
  });

  // Nothing is saved until the stored config has been loaded, so the empty initial form can
  // never overwrite the file.
  const [fields, setFields] = useState(EMPTY_FIELDS);
  const [hydrated, setHydrated] = useState(false);
  const [showLocationError, setShowLocationError] = useState(false);
  // What the file holds once in-flight saves land; unchanged fields are left out of a save.
  const lastSent = useRef<SavedFields | null>(null);

  // Loading while a save is in flight (e.g. the one fired as the page last closed) would seed
  // the form from the file as it was before that save.
  const loaded =
    configQuery.isSuccess &&
    configQuery.isFetchedAfterMount &&
    !configQuery.isFetching &&
    savesInFlight === 0
      ? configQuery.data
      : undefined;
  useEffect(() => {
    if (hydrated || !loaded) return;
    const stored = {
      commands: loaded.config?.['setup-worktree'] ?? [],
      location: loaded.config?.['worktree-base-path'] ?? '',
    };
    lastSent.current = toSaved(stored);
    setFields(stored);
    setHydrated(true);
    // A hand-edited file can hold a path the backend refuses; say so without waiting for a blur.
    setShowLocationError(stored.location !== '');
  }, [hydrated, loaded]);

  // Shared with the main-process validator so the field never accepts a path the save rejects.
  // Until `homeDir` arrives the verdict is 'unknown', which shows no error.
  const locationError = worktreeBasePathErrorMessage(
    checkWorktreeBasePath(fields.location, { homeDir, platform: isWindows() ? 'win32' : 'posix' }),
  );
  const visibleLocationError = showLocationError ? locationError : null;

  const save = (current = fields) => {
    if (!hydrated) return;
    // A path the check can't judge yet ('unknown') goes to the router, the sole authority.
    const patch = buildPatch(current, lastSent.current, !locationError);
    if (Object.keys(patch).length === 0) return;
    lastSent.current = { ...(lastSent.current ?? toSaved(current)), ...patch };
    saveMutation.mutate({ projectId, patch });
  };

  const commitLocation = () => {
    setShowLocationError(true);
    save();
  };

  // Closing Settings from the keyboard unmounts the page without blurring the focused field.
  const flushOnUnmount = useEffectEvent(() => save());
  useEffect(() => () => flushOnUnmount(), []);

  // Writing to the index one past the end appends: the always-empty last row is how commands are added.
  const setCommand = (index: number, value: string) => {
    const commands = [...fields.commands];
    commands[index] = value;
    setFields({ ...fields, commands });
  };

  const removeCommand = (index: number) => {
    const next = { ...fields, commands: fields.commands.filter((_, i) => i !== index) };
    setFields(next);
    save(next);
  };

  return (
    <SettingsSection title="Worktrees">
      <SettingsCard>
        {configQuery.error && (
          <div className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-3">
            <p role="alert" className="text-xs text-destructive">
              Couldn't load this project's worktree settings: {configQuery.error.message}
            </p>
            <Button variant="ghost" size="sm" onClick={() => configQuery.refetch()}>
              Retry
            </Button>
          </div>
        )}

        <SetupCommands
          commands={fields.commands}
          disabled={!hydrated}
          onChange={setCommand}
          onCommit={() => save()}
          onRemove={removeCommand}
        />
        <LocationField
          value={fields.location}
          disabled={!hydrated}
          placeholder={globalBasePath?.path}
          error={visibleLocationError}
          onChange={(location) => {
            setFields({ ...fields, location });
            // Partial paths like `~` are refused mid-typing; judge only what the user commits.
            setShowLocationError(false);
          }}
          onCommit={commitLocation}
        />
      </SettingsCard>

      <p
        aria-live="polite"
        className={cn(
          'px-1 text-xs',
          saveMutation.isError ? 'text-destructive' : 'text-muted-foreground',
        )}
      >
        {saveStatusText(saveMutation.status)}
      </p>
    </SettingsSection>
  );
}

type SetupCommandsProps = {
  commands: string[];
  disabled: boolean;
  onChange: (index: number, value: string) => void;
  onCommit: () => void;
  onRemove: (index: number) => void;
};

function SetupCommands({ commands, disabled, onChange, onCommit, onRemove }: SetupCommandsProps) {
  return (
    <div className="space-y-3 px-4 py-3">
      <div className="flex flex-col gap-1">
        <p id={COMMANDS_LABEL_ID} className="text-sm font-medium">
          Setup commands
        </p>
        <p id={COMMANDS_HINT_ID} className="text-xs leading-relaxed text-muted-foreground">
          Get each new worktree ready, like installing packages or copying your .env. They run in
          order, each on its own. <code className="font-mono">$ROOT_WORKTREE_PATH</code> is your
          main project folder.
        </p>
      </div>
      <div
        role="group"
        aria-labelledby={COMMANDS_LABEL_ID}
        aria-describedby={COMMANDS_HINT_ID}
        className="space-y-2"
      >
        {[...commands, ''].map((command, index) => (
          // Rows have no stable id; keying by position keeps focus in the row being typed in.
          // biome-ignore lint/suspicious/noArrayIndexKey: commands are positional
          <CommandRow
            key={index}
            command={command}
            index={index}
            isNewRow={index === commands.length}
            disabled={disabled}
            onChange={onChange}
            onCommit={onCommit}
            onRemove={onRemove}
          />
        ))}
      </div>
    </div>
  );
}

type CommandRowProps = Omit<SetupCommandsProps, 'commands'> & {
  command: string;
  index: number;
  isNewRow: boolean;
};

function newRowPlaceholder(index: number): string {
  return index === 0 ? 'bun install' : 'Add a command';
}

function CommandRow({
  command,
  index,
  isNewRow,
  disabled,
  onChange,
  onCommit,
  onRemove,
}: CommandRowProps) {
  return (
    <div className="flex items-start gap-2">
      {/* A row is one shell command, so it may span lines (Shift+Enter); Enter saves. */}
      <Textarea
        value={command}
        rows={1}
        onChange={(e) => onChange(index, e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
          e.preventDefault();
          onCommit();
        }}
        disabled={disabled}
        placeholder={isNewRow ? newRowPlaceholder(index) : undefined}
        aria-label={isNewRow ? 'New command' : `Command ${index + 1}`}
        spellCheck={false}
        className="field-sizing-content min-h-[var(--field-height-base)] resize-none py-[var(--field-pad-y-base)] font-mono text-xs"
      />
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        onClick={() => onRemove(index)}
        aria-label={`Remove command ${index + 1}`}
        className={cn(
          'mt-0.5',
          isNewRow ? 'invisible' : 'text-muted-foreground hover:text-destructive',
        )}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

type LocationFieldProps = {
  value: string;
  disabled: boolean;
  placeholder: string | undefined;
  error: string | null;
  onChange: (value: string) => void;
  onCommit: () => void;
};

function LocationField({
  value,
  disabled,
  placeholder,
  error,
  onChange,
  onCommit,
}: LocationFieldProps) {
  return (
    <div className="space-y-3 border-t border-border/60 px-4 py-3">
      <div className="flex flex-col gap-1">
        <Label htmlFor={LOCATION_ID} className="text-sm font-medium">
          Location
        </Label>
        <span id={LOCATION_HINT_ID} className="text-xs text-muted-foreground">
          Where new worktrees for this project go. Leave empty to use your default.
        </span>
      </div>
      <Input
        id={LOCATION_ID}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && onCommit()}
        disabled={disabled}
        placeholder={placeholder}
        error={error !== null}
        aria-invalid={error !== null}
        aria-describedby={error ? `${LOCATION_HINT_ID} ${LOCATION_ERROR_ID}` : LOCATION_HINT_ID}
        spellCheck={false}
        className="font-mono"
      />
      {error && (
        <p id={LOCATION_ERROR_ID} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
