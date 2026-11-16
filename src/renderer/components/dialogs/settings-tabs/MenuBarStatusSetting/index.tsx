import { toast } from 'sonner';
import { isMacOS } from '@/lib/utils/platform';
import { trpc } from '../../../../lib/trpc';
import { Switch } from '../../../ui/switch';

type Status = { enabled: boolean; appliesOnRestart: boolean };

/** The Preferences row that shows or hides Frink in the menu bar (system tray elsewhere). */
export function MenuBarStatusRow({
  isMac,
  status,
  onChange,
}: {
  isMac: boolean;
  status: Status | undefined;
  onChange: (enabled: boolean) => void;
}) {
  const label = `Show Frink in the ${isMac ? 'menu bar' : 'system tray'}`;
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3">
      <div className="flex flex-col gap-1 min-w-0">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="text-sm text-muted-foreground leading-relaxed">
          See what your agents are doing and what needs you, and allow commands, without opening
          Frink{status?.appliesOnRestart ? '. Takes effect the next time you open Frink' : ''}
        </span>
      </div>
      <Switch
        aria-label={label}
        checked={status?.enabled ?? true}
        onCheckedChange={onChange}
        className="shrink-0"
      />
    </div>
  );
}

export function MenuBarStatusSetting() {
  const utils = trpc.useUtils();
  const { data } = trpc.tray.showStatus.useQuery();
  const setShowStatus = trpc.tray.setShowStatus.useMutation({
    onMutate: async ({ enabled }) => {
      // An in-flight read would otherwise land after this and put the old value back.
      await utils.tray.showStatus.cancel();
      utils.tray.showStatus.setData(undefined, (old) => old && { ...old, enabled });
    },
    onError: (error) => toast.error(error.message),
    onSettled: () => utils.tray.showStatus.invalidate(),
  });
  return (
    <MenuBarStatusRow
      isMac={isMacOS()}
      status={data}
      onChange={(enabled) => setShowStatus.mutate({ enabled })}
    />
  );
}
