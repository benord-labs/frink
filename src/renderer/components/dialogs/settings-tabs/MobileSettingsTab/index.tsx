import { Button } from '@benord-labs/frink-primitives';
import { Smartphone } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { Switch } from '@/components/ui/switch';
import { trpc } from '@/lib/trpc';
import { mobilePairingLink } from '../../../../../shared/types/remote/mobile';
import { SettingsTabHeader } from '../SettingsTabHeader';
import { SETTINGS_TAB_PAGE_CLASS } from '../settings-tab-surface';

async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    toast.success('Copied');
  } catch {
    toast.error('Could not copy. Select the text and copy it manually.');
  }
}

// Reason: One form owns pairing generation, expiry, and confirmation states.
// fallow-ignore-next-line complexity
function PairPhone() {
  const [now, setNow] = useState(Date.now());
  const pairing = trpc.mobile.pair.useMutation();
  const { mutate } = pairing;
  // Opening this page is the whole setup: show a fresh code straight away.
  useEffect(() => mutate(), [mutate]);
  useEffect(() => {
    if (!pairing.data) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [pairing.data]);
  const expired = pairing.data ? now >= Date.parse(pairing.data.expiresAt) : false;
  const pairingText = pairing.data ? mobilePairingLink(pairing.data.pairing) : '';

  return (
    <SettingsSection
      title="Pair your iPhone"
      description="Scan the code with your iPhone camera, or copy it and choose Paste pairing code in the Frink app."
    >
      <SettingsCard>
        <div className="space-y-3 px-4 py-4">
          {pairing.error && (
            <div className="space-y-2">
              <p role="alert" className="text-sm text-destructive">
                {pairing.error.message}
              </p>
              <Button disabled={pairing.isPending} onClick={() => mutate()}>
                Try again
              </Button>
            </div>
          )}
          {pairing.data && (
            <div className="space-y-2">
              <p className="text-sm" role="status">
                {expired
                  ? 'Code expired.'
                  : 'Valid for five minutes and one phone. Keep this code private.'}
              </p>
              {expired && (
                <Button disabled={pairing.isPending} onClick={() => mutate()}>
                  {pairing.isPending ? 'Creating code…' : 'Create a new code'}
                </Button>
              )}
              {!expired && (
                <>
                  <div className="w-fit rounded-xl bg-white p-3">
                    <QRCodeSVG
                      value={pairingText}
                      size={192}
                      title="Scan to pair your iPhone with Frink"
                    />
                  </div>
                  <textarea
                    readOnly
                    value={pairingText}
                    aria-label="Pairing code"
                    className="min-h-24 w-full resize-none rounded-md border border-border bg-muted/40 p-3 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <Button variant="secondary" onClick={() => void copyText(pairingText)}>
                    Copy pairing code
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}

// Reason: Keep access, recovery, and device revocation states in one settings view.
// fallow-ignore-next-line complexity
export function MobileSettingsTab() {
  const status = trpc.mobile.status.useQuery(undefined, { refetchInterval: 5_000 });
  const refresh = () => {
    void status.refetch();
  };
  const onError = (error: { message: string }) => {
    toast.error(error.message);
    refresh();
  };
  const enable = trpc.mobile.enable.useMutation({ onSuccess: refresh, onError });
  const disable = trpc.mobile.disable.useMutation({ onSuccess: refresh, onError });
  const revoke = trpc.mobile.revoke.useMutation({ onSuccess: refresh, onError });
  const busy = enable.isPending || disable.isPending;

  return (
    <div className={SETTINGS_TAB_PAGE_CLASS}>
      <SettingsTabHeader
        title="Mobile"
        description="Keep your Flows moving, answer questions and chat from your iPhone."
      />
      {status.isLoading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading mobile access…
        </p>
      ) : status.error ? (
        <div role="alert" className="space-y-2 text-sm">
          <p>Could not load mobile access.</p>
          <Button variant="secondary" onClick={refresh}>
            Retry
          </Button>
        </div>
      ) : status.data ? (
        <>
          <SettingsSection title="Access to this computer">
            <SettingsCard>
              <div className="flex items-start justify-between gap-4 px-4 py-4">
                <div className="space-y-1">
                  <label htmlFor="mobile-enabled" className="text-sm font-medium">
                    Allow mobile access
                  </label>
                  <p
                    id="mobile-enabled-hint"
                    className="max-w-prose text-xs leading-relaxed text-muted-foreground"
                  >
                    Keep a Frink window open and this computer awake. Turning this off disconnects
                    every phone and removes their access. You will need to pair again.
                  </p>
                  <p className="text-xs text-muted-foreground" role="status">
                    {!status.data.running
                      ? 'Mobile access is off'
                      : status.data.relayConnected
                        ? 'Ready. Your iPhone can reach this computer from anywhere.'
                        : 'Connecting to the Frink relay…'}
                  </p>
                </div>
                <Switch
                  id="mobile-enabled"
                  aria-describedby="mobile-enabled-hint"
                  checked={status.data.enabled}
                  disabled={busy}
                  onCheckedChange={(checked) => (checked ? enable.mutate() : disable.mutate())}
                />
              </div>
              {status.data.error && (
                <div className="space-y-2 border-t border-border/60 px-4 py-3">
                  <p role="alert" className="text-sm text-destructive">
                    {status.data.error}
                  </p>
                  <Button variant="secondary" disabled={busy} onClick={() => disable.mutate()}>
                    Reset mobile access
                  </Button>
                </div>
              )}
            </SettingsCard>
          </SettingsSection>
          {status.data.running && <PairPhone />}
          <SettingsSection title="Paired phones">
            <SettingsCard>
              {status.data.devices.length === 0 ? (
                <p className="px-4 py-4 text-sm text-muted-foreground">No phones paired yet.</p>
              ) : (
                <ul className="divide-y divide-border/60">
                  {status.data.devices.map((device) => (
                    <li key={device.id} className="flex items-center gap-3 px-4 py-3">
                      <Smartphone className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{device.name}</p>
                        <p className="text-xs text-muted-foreground">
                          Paired {new Date(device.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={revoke.isPending}
                        aria-label={`Remove access for ${device.name}`}
                        onClick={() => revoke.mutate({ id: device.id })}
                      >
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </SettingsCard>
          </SettingsSection>
        </>
      ) : null}
    </div>
  );
}
