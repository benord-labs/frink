/** The provider registry, one file per {@link ProviderCategory}. This barrel is the only import
 * path: every consumer keeps importing `./providers`. */
import { ANALYTICS_PROVIDERS } from './analytics';
import { CODE_PROVIDERS } from './code';
import { CUSTOM_PROVIDERS } from './custom';
import { INFRASTRUCTURE_PROVIDERS } from './infrastructure';
import { MESSAGING_PROVIDERS } from './messaging';
import { PAYMENT_PROVIDERS } from './payments';
import { TICKETING_PROVIDERS } from './ticketing';
import type { Provider } from '../types';

export const PROVIDERS: ReadonlyArray<Provider> = [
  ...TICKETING_PROVIDERS,
  ...CODE_PROVIDERS,
  ...MESSAGING_PROVIDERS,
  ...ANALYTICS_PROVIDERS,
  ...INFRASTRUCTURE_PROVIDERS,
  ...PAYMENT_PROVIDERS,
  ...CUSTOM_PROVIDERS,
];

export const PROVIDER_IDS = PROVIDERS.map((p) => p.id);

export type ProviderId = (typeof PROVIDERS)[number]['id'];
