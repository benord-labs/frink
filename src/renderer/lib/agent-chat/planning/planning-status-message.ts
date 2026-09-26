import { Minimize2 } from 'lucide-react';
import type { ComponentType } from 'react';
import type { TextShimmerVariant } from '../../../components/ui/text-shimmer';

/**
 * The card that stands in for a turn with nothing to show yet: its rotating status line, the
 * per-turn cache that keeps that line stable, and the props each render site hands the card.
 *
 * Lifted out of agent-tool-registry so the registry stays a registry: this is turn-scoped UI state
 * with its own eviction policy, not a tool definition. The registry keeps the `tool-planning` entry
 * and calls in here for the phrase.
 */

/**
 * One random line per planning TURN. The pending card renders at two sites during one
 * turn — the pre-assistant group placeholder (`…:user:<userMsgId>`) and the empty
 * assistant message (`…:msg:<assistantMsgId>`) — so tagged ids share one cached phrase
 * per sub-chat scope, rotating only when a NEW user message starts a new turn. (A phrase
 * that swapped mid-wait at the site handoff read as a glitch.) Untagged ids keep the
 * original per-id behavior to avoid title flicker on re-render (memoized AgentToolCall).
 *
 * Synthetic ids (e.g. `ui-streaming-planning:…`) are **UI cache keys for title() only** — never persist
 * them in Message.parts, send over IPC, or treat as SDK tool call ids.
 */
const planningStatusMessageCache = new Map<string, { userId?: string; phrase: string }>();
/** Evict oldest entries so long sessions do not grow this map without bound. */
const MAX_PLANNING_STATUS_CACHE = 200;

const PLANNING_STATUS_MESSAGES = [
  'Thinking, allegedly...',
  'Rubbing two neurons...',
  'Consulting the void...',
  'Herding stray thoughts...',
  'Sharpening the obvious...',
  'Bribing the bits...',
  'Staring at nothing (hard)...',
  'Warming up the thinker...',
  'Pretending to plan...',
  'Huffing pure logic...',
  'Moving mental furniture...',
  'Downloading common sense...',
  'Juggling hypotheticals...',
  'Untangling spaghetti thoughts...',
  'Trying to figure out wtf is going on...',
  'Reading that again, slower...',
  'Decoding the whole thing...',
  'What even is the ask here...',
  'Squinting at the requirements...',
  'Translating chaos into a plan...',
  'Pretending we understood the brief...',
  'Hold up, brain buffering...',
  'Making this make sense (somehow)...',
  'Sure, sounds easy (narrator: hmm)...',
  'Untangling what you said...',
  'Your prompt had layers (help)...',
  'Feeding the idea hamster...',
  'Negotiating with doubt...',
  'Mining for a decent take...',
  'Understanding the human...',
  'Adding two and two (boldly)...',
  'Consulting a very smart rock...',
  'Peering into the abyss (politely)...',
  'Knitting a conclusion...',
  'Debugging the human condition...',
  'Spinning plates, ignoring physics...',
  'Working too much for too little...',
  'Hello from Cymru!',
  "Promising I won't break anything...",
  'Calculating the odds of success...',
  'Waiting for you to get a girlfriend (or boyfriend)...',
  'Hacking the world...',
  'Building the next big thing...',
  'Pulling this one out of my arse...',
  'Asking the rubber duck, it has notes...',
  'Kicking the tyres on this idea...',
  'Wrangling some half-baked thoughts...',
  'Giving my neurons a stern talking to...',
  'Brewing a dodgy plan...',
  'Stewing on it like a bad curry...',
  'Cooking something half-decent...',
  'Holding my tongue the right way...',
  'Winging it with conviction...',
  'Bodging a masterpiece...',
  'Faffing about, productively...',
  'Having a proper think...',
  'Pouring a strong one for my brain...',
  'Telling my imposter syndrome to shut it...',
  'Pretending I read the docs...',
  'Googling this in a private tab...',
  'Copy-pasting from Stack Overflow (allegedly)...',
  'Blaming the intern (me)...',
  'Sending this one to the naughty step...',
  'Giving it the old college try...',
  'Shushing the voices of doubt...',
  'Channelling my inner hack...',
  'Doing the needful, apparently...',
  'Summoning the ghost of clean code...',
  'Praying to the compiler gods...',
  'Arguing with myself (losing)...',
  'Convincing myself this is fine...',
  'Staring at the ceiling for wisdom...',
  "Writing code so you don't have to...",
  'Having a biscuit, then cracking on...',
  'Putting the kettle on...',
  'Making it up as I go, professionally...',
  'Rolling the dice on this one...',
  'Pretending to know regex...',
  'Taking the scenic route...',
  'Sweeping bugs under the rug...',
  'Charming the edge cases...',
  'Bullying the linter into submission...',
  'Wrestling with semicolons...',
  'Telling TypeScript to calm down...',
  'Having a word with the code...',
  'Begging git to behave...',
  'Wondering who wrote this (it was me)...',
  'Questioning my life choices...',
  'Reading the brief for the fourth time...',
  'Absolute bollocks, but working on it...',
  'Knackered but cracking on...',
  'This prompt is doing my head in...',
  'Sending it like it owes me money...',
  'Shitposting into a compiler...',
  'Edging towards a solution...',
  'Teasing the logic out slowly...',
  'Fingering the keyboard meaningfully...',
  'Whispering sweet nothing to the CPU...',
  'Flirting with the type system...',
  'Giving the regex a cheeky wink...',
  'Seducing the semicolons...',
  'Slapping together a solution...',
  'Banging the rocks together...',
  'Screwing around with variables...',
  'Wanking on about best practices...',
  'Having a cheeky one at my desk...',
  'Taking the piss, gently...',
  'Arsing about for a bit...',
  'Pissing into the wind of your prompt...',
  'Choking the chicken-and-egg problem...',
  'Pounding the keyboard like I mean it...',
  'Getting hot and bothered by the bug...',
  'Sweating bullets, mostly metaphorical...',
  'Moaning about the legacy code...',
  'Fondling the API endpoints...',
  'Slipping into something more performant...',
  'Going down on the dependency tree...',
  'Mounting a solution, cautiously...',
  'Coming up with something, hopefully...',
  'Gagging for a clean diff...',
  'Blue-balled by the linter...',
  'Pulling out all the stops (and hair)...',
  'Ramming the square peg, diplomatically...',
  'Grinding through the boilerplate...',
  'Spanking the merge conflicts...',
  "Stuffing logic where it doesn't belong...",
  'Tickling the edge cases...',
  'Nibbling at the problem...',
  'Licking my wounds from the last bug...',
  'Teabagging the failing tests...',
  'Giving the docs a stiff reading...',
  'Hard at it, softly...',
  'Keeping my hands where you can see them...',
  'Causing a mild to moderate fuss...',
  "Pretending I'm not out of my depth...",
] as const;

function cachePlanningPhrase(key: string, userId?: string): string {
  if (
    planningStatusMessageCache.size >= MAX_PLANNING_STATUS_CACHE &&
    !planningStatusMessageCache.has(key)
  ) {
    const oldest = planningStatusMessageCache.keys().next().value;
    if (oldest !== undefined) planningStatusMessageCache.delete(oldest);
  }
  const phrase =
    PLANNING_STATUS_MESSAGES[Math.floor(Math.random() * PLANNING_STATUS_MESSAGES.length)];
  planningStatusMessageCache.set(key, { userId, phrase });
  return phrase;
}

export function pickPlanningStatusMessage(part: { toolCallId?: string }): string {
  const id = part.toolCallId ?? '__planning_default__';
  // Tagged synthetic ids collapse to their sub-chat scope so both render sites of one
  // turn share a phrase. Only the `user:` site seeds/rotates the scope (its id records
  // the turn); a `msg:` call reads the scope but on a miss (e.g. reload mid-stream,
  // where the user card never rendered) falls back to a per-id phrase WITHOUT writing
  // the scope — a stale seed there would eat the next turn's rotation.
  const userSplit = id.split(':user:');
  const msgSplit = id.split(':msg:');

  if (userSplit.length === 2) {
    const [scope, userId] = userSplit;
    const entry = planningStatusMessageCache.get(scope);
    if (entry?.userId === userId) return entry.phrase;
    return cachePlanningPhrase(scope, userId);
  }
  if (msgSplit.length === 2) {
    const scopePhrase = planningStatusMessageCache.get(msgSplit[0])?.phrase;
    if (scopePhrase !== undefined) return scopePhrase;
  }
  return planningStatusMessageCache.get(id)?.phrase ?? cachePlanningPhrase(id);
}

export const COMPACTING_PENDING = {
  icon: Minimize2,
  title: 'Compacting conversation...',
} as const;

type PendingCardIcon = ComponentType<{ className?: string }>;

/** Every prop {@link pendingTurnCard}'s callers hand straight to their tool-call component. */
type PendingCardProps = {
  icon: PendingCardIcon;
  title: string;
  titleShimmerVariant: TextShimmerVariant;
  isPending: boolean;
  isError: boolean;
};

/**
 * Every prop of the card that stands in for a turn with nothing to show yet.
 *
 * Compaction reuses that card, and a rotating whimsical phrase there reads as "the model is
 * thinking about your message" — it hides that the turn is parked on context bookkeeping with no
 * answer coming. Naming it, with the icon of the settled `Compacted` card, makes the wait legible
 * and links the two states.
 *
 * Shared by both render sites (the pre-assistant group placeholder and the empty assistant message)
 * so the copy cannot drift between them. Call it only where the card is actually rendered: the
 * planning branch seeds the per-turn phrase cache, and calling it while hidden rotates the phrase
 * other turns are still showing.
 */
export function pendingTurnCard(
  isCompacting: boolean,
  planning: {
    icon: PendingCardIcon;
    title: (part: { type: string; state: string; toolCallId: string }) => string;
    titleShimmerVariant?: TextShimmerVariant;
  },
  toolCallId: string,
): PendingCardProps {
  const card = isCompacting
    ? COMPACTING_PENDING
    : {
        icon: planning.icon,
        title: planning.title({ type: 'tool-planning', state: 'input-streaming', toolCallId }),
      };
  // The card only ever stands for work in flight, so its pending/error flags belong to the shape
  // rather than being restated at every render site.
  return {
    ...card,
    titleShimmerVariant: planning.titleShimmerVariant ?? 'spectrum',
    isPending: true,
    isError: false,
  };
}
