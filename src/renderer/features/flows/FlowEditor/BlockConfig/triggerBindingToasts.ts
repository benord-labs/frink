import { toast } from 'sonner';

export function toastTriggerBindingMutationError(err: { message?: string }): void {
  toast.error(err.message ?? 'Binding request failed');
}
