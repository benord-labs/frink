import type { MobileRequest, MobileResponses } from '../../../../shared/types/remote/mobile';
import { steerActiveTurn } from '../../socket/steering';
import { requireChat } from './context';

type SteerResult = MobileResponses['steerMessage'];
// A steer is not saved as a message, so request-id dedup must live here: a phone retrying after a
// timeout would otherwise inject the same text twice. Bounded; old ids fall out first.
const outcomes = new Map<string, Promise<SteerResult>>();
const MAX_REMEMBERED = 256;

/** Desktop's Steer: the text joins the running turn at its next step and never starts a turn, so
 *  it skips the Flow-ownership check a send makes. Not delivered means nothing was sent. */
export function steerMobileMessage(
  input: Extract<MobileRequest, { type: 'steerMessage' }>,
): Promise<SteerResult> {
  const known = outcomes.get(input.requestId);
  if (known) return known;
  const result = requireChat(input.chatId, input.subChatId)
    .then(() => steerActiveTurn(input.subChatId, { text: input.text }))
    .then((outcome): SteerResult => ({
      outcome: outcome === 'delivered' ? 'delivered' : 'not-delivered',
    }));
  outcomes.set(input.requestId, result);
  if (outcomes.size > MAX_REMEMBERED) outcomes.delete(outcomes.keys().next().value!);
  // A failed call delivered nothing, so a retry must run again.
  result.catch(() => outcomes.delete(input.requestId));
  return result;
}
