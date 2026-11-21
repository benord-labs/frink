import { applyChatOps } from '@frink/shared/lib/mobile-chat-ops';
import type {
  MobileChatDetail,
  MobileChatEvent,
  MobileChatOp,
  MobileResponses,
} from '@frink/shared/types/remote/mobile';
import type { RelayLink } from '../relay/client';
import { ApiError } from '../relay/error';

/** How long the stream waits to try a failed watch again, and between fresh copies of a live one. */
export const STREAM_RETRY_MS = 15_000;

/** One live watch: its sub, the last event applied, and the chat as it stands after it. */
export type Watching = { sub: string; seq: number; detail: MobileChatDetail };
/** What one event frame does to a watch. */
export type EventStep =
  | { kind: 'apply'; watching: Watching }
  /** A repeat of an event already applied. */
  | { kind: 'ignore' }
  /** The desktop ended the watch with a resync: watch again. */
  | { kind: 'ended' }
  /** A gap, or a change that does not fit: unwatch, then watch again. */
  | { kind: 'broken' };

function decodeOps(body: Uint8Array): MobileChatOp[] | null {
  try {
    const event: Partial<MobileChatEvent> | null = JSON.parse(new TextDecoder().decode(body));
    return Array.isArray(event?.ops) ? event.ops : null;
  } catch {
    return null;
  }
}

/** A resync is obeyed at any seq, even one repeating a frame already applied. */
export function nextStep(watching: Watching, seq: number, body: Uint8Array): EventStep {
  const ops = decodeOps(body);
  if (!ops) return { kind: 'broken' };
  if (ops.some((op) => op.op === 'resync')) return { kind: 'ended' };
  if (seq <= watching.seq) return { kind: 'ignore' };
  if (seq !== watching.seq + 1) return { kind: 'broken' };
  const detail = applyChatOps(watching.detail, ops);
  if (detail === 'resync') return { kind: 'broken' };
  return { kind: 'apply', watching: { ...watching, seq, detail } };
}

/** Drops held messages before `first`, the first one the screen's latest page shows: the desktop
 * pages them out of the chat, so a page read and a live update agree on where it starts. */
function fromFirst(detail: MobileChatDetail, first: string | undefined): MobileChatDetail {
  const start = detail.messages.findIndex((message) => message.id === first);
  return start > 0 ? { ...detail, messages: detail.messages.slice(start) } : detail;
}

/** Only a desktop too old to know `watchChat` answers it 400 (a current one refuses for a passing
 * reason with 409); that link stays on polls, and the next one dialled asks again. */
const watchUnsupported = (error: Error) => error instanceof ApiError && error.status === 400;

export type ChatStreamDeps = {
  /** The link the next request travels on. */
  link: () => RelayLink;
  watch: () => Promise<MobileResponses['watchChat']>;
  /** Sent on the same link as the watch; failures are ignored. */
  unwatch: (sub: string) => void;
  /** Whether a watch may start now: the app is in front and the computer is still the one shown. */
  canWatch: () => boolean;
  show: (detail: MobileChatDetail) => void;
  /** The id of the first message the screen shows now. */
  first: () => string | undefined;
  live: (live: boolean) => void;
  /** Names the computer and conversation, so two screens of one conversation do not race. */
  conversation: string;
};

type Current = Watching & { link: RelayLink; off: () => void };

/** Links whose desktop does not know live watches; a newly dialled link is asked again. */
const unsupported = new WeakSet<RelayLink>();
/** The stream that watches each conversation, from its first ask until it stops. */
const owners = new Map<string, ChatStream>();
/** Streams that left a conversation's watch to another screen, woken when that screen stops. */
const waiting = new Map<string, Set<ChatStream>>();

function waitingWith(conversation: string, stream: ChatStream) {
  return (waiting.get(conversation) ?? new Set<ChatStream>()).add(stream);
}

/** Keeps one conversation live on screen: watches it, applies its events in order, and watches
 * again after a resync, a gap or a lost link. `stop` ends it on every path. */
export class ChatStream {
  private attempt = 0;
  /** The attempt whose watch is on its way, if any. */
  private asking = 0;
  private current: Current | null = null;
  private offLost: () => void = () => {};
  private retry: ReturnType<typeof setTimeout> | undefined;
  private fresh: ReturnType<typeof setTimeout> | undefined;
  /** What `live` last said: true from an answered watch until it ends, a fresh copy included. */
  private live = false;
  private stopped = false;

  constructor(private readonly deps: ChatStreamDeps) {}

  start() {
    this.rewatch();
  }

  stop() {
    this.halt();
    ChatStream.wake(this.deps.conversation);
  }

  /** Swaps a live watch for a new one, whose answer is a fresh copy of the whole chat. The old
   * watch is unwatched first and its later events ignored, so the transcript never steps back. */
  refresh() {
    if (!this.current) return;
    this.end(true, true);
    this.rewatch();
  }

  private static wake(conversation: string) {
    const streams = waiting.get(conversation);
    waiting.delete(conversation);
    for (const stream of streams ?? []) stream.rewatch();
  }

  /** Ends this stream for good; waiting screens stay asleep, so none dials a forgotten computer. */
  private halt() {
    const { conversation } = this.deps;
    this.stopped = true;
    this.attempt++;
    clearTimeout(this.retry);
    this.offLost();
    waiting.get(conversation)?.delete(this);
    if (owners.get(conversation) === this) owners.delete(conversation);
    this.end(true);
  }

  /** Watches once; an attempt that ends without a watch, and is not overtaken, is not live. */
  private async begin() {
    const link = this.claim();
    const attempt = this.attempt;
    const answer = link && (await this.ask(link, attempt));
    if (link && answer && this.follow(link, attempt, answer)) return;
    if (attempt === this.attempt) this.report(false);
  }

  private report(live: boolean) {
    if (this.live === live) return;
    this.live = live;
    this.deps.live(live);
  }

  /** Starts a new attempt on the current link, or returns null when no watch may start now. */
  private claim(): RelayLink | null {
    const { deps } = this;
    if (this.stopped || !deps.canWatch()) return null;
    const link = deps.link();
    if (link.lost) return null;
    const attempt = ++this.attempt;
    this.offLost();
    this.offLost = link.onLost((gone) => this.lost(attempt, gone));
    return unsupported.has(link) ? null : link;
  }

  /** Sends the watch; a failure marks the link unsupported or schedules another try. */
  private async ask(link: RelayLink, attempt: number) {
    this.asking = attempt;
    try {
      return await this.deps.watch();
    } catch (error) {
      if (attempt !== this.attempt) return undefined;
      if (error instanceof Error && watchUnsupported(error)) unsupported.add(link);
      else this.later();
      return undefined;
    } finally {
      if (this.asking === attempt) this.asking = 0;
    }
  }

  /** Listens to an answered watch. A late one is unwatched on its own link while that is live (a
   * live link is the one requests travel on); a lost link's channel already dropped it. */
  private follow(link: RelayLink, attempt: number, answer: MobileResponses['watchChat']) {
    if (link.lost) return false;
    if (attempt !== this.attempt) return void this.deps.unwatch(answer.sub);
    const { sub } = answer;
    const detail = fromFirst(answer.detail, this.deps.first());
    const off = link.listen(sub, (seq, body) => this.event(seq, body));
    this.current = { sub, seq: 0, detail, link, off };
    this.deps.show(detail);
    this.report(true);
    this.fresh = setTimeout(() => this.refresh(), STREAM_RETRY_MS);
    return true;
  }

  private event(seq: number, body: Uint8Array) {
    if (!this.current) return;
    const step = nextStep(this.current, seq, body);
    if (step.kind === 'ignore') return;
    if (step.kind === 'apply') {
      const detail = fromFirst(step.watching.detail, this.deps.first());
      this.current = { ...this.current, ...step.watching, detail };
      return this.deps.show(detail);
    }
    this.end(step.kind === 'broken');
    this.rewatch();
  }

  /** Drops the current watch; `unwatch` tells the desktop, which otherwise keeps it until evicted.
   * The stream stays live only for a fresh copy on its way. */
  private end(unwatch: boolean, refreshing = false) {
    clearTimeout(this.fresh);
    const current = this.current;
    this.current = null;
    current?.off();
    if (current && unwatch && !current.link.lost) this.deps.unwatch(current.sub);
    if (!refreshing) this.report(false);
  }

  /** A live watch's lost link is redialled at once, one lost mid-ask (an unreachable computer)
   * later, so an offline phone does not spin; a link closed on purpose ends the stream. */
  private lost(attempt: number, gone: boolean) {
    if (attempt !== this.attempt) return;
    if (gone) return this.halt();
    const wasAsking = this.asking === attempt;
    this.attempt++;
    this.end(false);
    if (wasAsking) this.later();
    else this.rewatch();
  }

  private later() {
    clearTimeout(this.retry);
    this.retry = setTimeout(() => this.rewatch(), STREAM_RETRY_MS);
  }

  /** One screen at a time watches a conversation, as the desktop keeps one watch of it per link;
   * another screen of it waits until that one stops. */
  private rewatch() {
    clearTimeout(this.retry);
    const { conversation } = this.deps;
    const owner = owners.get(conversation);
    if (owner && owner !== this) {
      waiting.set(conversation, waitingWith(conversation, this));
      return this.report(false);
    }
    owners.set(conversation, this);
    waiting.get(conversation)?.delete(this);
    void this.begin();
  }
}
