/** One RAW vendor body per catalog event, so a test event delivers what the vendor would and really
 * starts a Flow. Each sample must resolve to the event it is filed under; the parity tests assert it. */
import type { TriggerSampleCatalog } from '../types';
import { ANALYTICS_TRIGGER_SAMPLES } from './analytics';
import { CODE_TRIGGER_SAMPLES } from './code';
import { CUSTOM_TRIGGER_SAMPLES } from './custom';
import { INFRASTRUCTURE_TRIGGER_SAMPLES } from './infrastructure';
import { MESSAGING_TRIGGER_SAMPLES } from './messaging';
import { PAYMENTS_TRIGGER_SAMPLES } from './payments';
import { TICKETING_TRIGGER_SAMPLES } from './ticketing';

/** `TRIGGER_SAMPLES[providerId][eventId]`. Every catalog event has one. */
export const TRIGGER_SAMPLES: TriggerSampleCatalog = {
  ...TICKETING_TRIGGER_SAMPLES,
  ...CODE_TRIGGER_SAMPLES,
  ...MESSAGING_TRIGGER_SAMPLES,
  ...ANALYTICS_TRIGGER_SAMPLES,
  ...INFRASTRUCTURE_TRIGGER_SAMPLES,
  ...PAYMENTS_TRIGGER_SAMPLES,
  ...CUSTOM_TRIGGER_SAMPLES,
};
