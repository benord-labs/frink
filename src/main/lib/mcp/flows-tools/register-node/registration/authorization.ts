import type { CustomNodeRegistrationPresentation } from '../../../../../../shared/types/permissions';

type RegisterNodeAuthorizationDecision =
  | { allowed: true }
  | { allowed: false; reason?: string };

type RegisterNodeAuthorization = (
  presentation: CustomNodeRegistrationPresentation,
  signal?: AbortSignal,
) => Promise<RegisterNodeAuthorizationDecision>;

export type RegisterNodeOptions = {
  /** True only for calls carrying a live chat context; the gate auto-allows context-less local callers, so registration must refuse them itself. */
  chatScoped: boolean;
  authorize: RegisterNodeAuthorization;
  isExecutionCurrent?: () => boolean;
  signal?: AbortSignal;
};
