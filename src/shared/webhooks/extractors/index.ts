import { isPayloadDrivenWebhookProvider } from '../../integrations/selectors';
import type { PayloadExtractorId, Provider } from '../../integrations/types';
import { genericExtractor, pasteUrlExtractor } from './generic';
import { linearExtractor } from './linear';
import { shortcutExtractor } from './shortcut';
import type { PayloadExtractor } from './types';

export const extractors: Record<PayloadExtractorId, PayloadExtractor> = {
  shortcut: shortcutExtractor,
  linear: linearExtractor,
  generic: genericExtractor,
};

/** A row's own extractor: data-driven when the row names no vendor code, the curated one otherwise. */
export function extractorFor(provider: Provider): PayloadExtractor {
  return isPayloadDrivenWebhookProvider(provider)
    ? pasteUrlExtractor(provider)
    : extractors[provider.payload_extractor];
}
