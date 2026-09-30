import Constants from 'expo-constants';
import type { LiveActivity } from 'expo-widgets';
import { AppState } from 'react-native';
import type { MobileAgentCounts } from '@frink/shared/types/remote/mobile';
import FrinkStatus from '../../widgets/frink-status';
import { requestNotifications, type Connection } from '../api';
import { QUEUE_LINK } from '../pairing-link';

// Frink Dev is signed for Apple's sandbox, which the Mac's forwarder doesn't use: its card shows the
// counts it started with and never registers for updates.
const REMOTE = !Constants.expoConfig?.ios?.bundleIdentifier?.endsWith('.dev');

/** What this iPhone last told the Mac, and the card whose token changes it listens to. */
export type Session = { sent: string | null; listening?: { id: string; remove: () => void } };

function end(card: LiveActivity<MobileAgentCounts>) {
  card.end('immediate').catch(() => undefined);
}

/** Records the value before sending, so overlapping calls send each change only once. */
async function register(session: Session, host: Connection, token: string | null) {
  if (token === session.sent) return;
  const previous = session.sent;
  session.sent = token;
  try {
    await requestNotifications(host, { activityToken: token });
  } catch (error) {
    if (session.sent === token) session.sent = previous;
    throw error;
  }
}

function listen(session: Session, host: Connection, card: LiveActivity<MobileAgentCounts>) {
  if (session.listening?.id === card.getId()) return;
  session.listening?.remove();
  const subscription = card.addPushTokenListener(
    ({ pushToken }) => void register(session, host, pushToken).catch(() => undefined),
  );
  session.listening = { id: card.getId(), remove: () => subscription.remove() };
}

/** Hands the card's update token to the Mac now, and again whenever iOS rotates it. */
async function follow(session: Session, host: Connection, card: LiveActivity<MobileAgentCounts>) {
  if (!REMOTE) return;
  listen(session, host, card);
  const token = await card.getPushToken();
  if (token) await register(session, host, token);
}

/** A new card, or 'refused' when Live Activities are off for Frink in iPhone Settings. */
function start(agents: MobileAgentCounts) {
  try {
    return FrinkStatus.start(agents, QUEUE_LINK);
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_LIVE_ACTIVITIES_NOT_SUPPORTED') return 'refused';
    throw error;
  }
}

/**
 * Brings the Lock Screen card in line with the switch and the Mac's counts. Only the app starts a
 * card (in the foreground, while something runs); only the Mac updates it. Returns true when iOS
 * refused to start one, false once a card started or the switch is off, undefined otherwise.
 */
export async function reconcile(
  session: Session,
  host: Connection,
  on: boolean,
  agents: MobileAgentCounts | undefined,
): Promise<boolean | undefined> {
  const cards = FrinkStatus.getInstances();
  if (!on) {
    cards.forEach(end);
    await register(session, host, null);
    return false;
  }
  // A card still up at 0/0 missed the Mac's end.
  if (agents && agents.running + agents.needsYou === 0) return void cards.forEach(end);
  const [card, ...extras] = cards;
  extras.forEach(end);
  if (card) return void (await follow(session, host, card));
  if (!agents?.running || AppState.currentState !== 'active') return undefined;
  const started = start(agents);
  if (started === 'refused') return true;
  await follow(session, host, started);
  return false;
}

/**
 * Unpairing, or pairing another Mac, takes the card down and asks the old Mac to stop updating it,
 * whether or not this launch sent it a token.
 */
export function endSession(session: Session, host: Connection | null) {
  session.listening?.remove();
  FrinkStatus.getInstances().forEach(end);
  if (host) void requestNotifications(host, { activityToken: null }).catch(() => undefined);
}
