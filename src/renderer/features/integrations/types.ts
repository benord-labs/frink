/**
 * Integration Types
 */
import type { ProviderId } from '../../../shared/integrations/providers';

/** A provider catalog id (`PROVIDERS`), as the local account table stores it. */
export type IntegrationProvider = ProviderId;

export type ConnectedIntegration = {
  id: string;
  provider: IntegrationProvider;
  accountName: string;
  accountIdentifier: string;
};
