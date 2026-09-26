import type { TriggerSampleCatalog } from '../types';

/** No vendor behind it: any system that can POST. One raw vendor body per catalog event. */
export const CUSTOM_TRIGGER_SAMPLES = {
  generic_webhook: {
    received: { id: 'evt_1', source: 'my-system', message: 'A test event from Frink' },
  },
} satisfies TriggerSampleCatalog;
