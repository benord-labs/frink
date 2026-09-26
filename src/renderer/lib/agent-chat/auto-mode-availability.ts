import { supportsNativeAutoReview } from '../../../shared/lib/models';

export function getAutoModeUnavailableReason({
  accountResolved,
  isAuthenticated,
  accountType,
  selectedModelId,
}: {
  accountResolved: boolean;
  isAuthenticated: boolean | undefined;
  accountType: string | undefined;
  selectedModelId: string;
}): string {
  if (!accountResolved) return 'Checking whether Auto Mode is available.';
  if (!isAuthenticated) return 'Connect an account to use Auto Mode.';
  return supportsNativeAutoReview(accountType ?? '', selectedModelId)
    ? ''
    : 'The selected provider or model does not support Auto Mode.';
}
