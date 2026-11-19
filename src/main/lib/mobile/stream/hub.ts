import { randomUUID } from 'node:crypto';
import log from 'electron-log';
import type { MobileEnvelope } from '../../../../shared/types/remote/mobile-envelope';
import type { MobileChatDetail, MobileChatEvent } from '../../../../shared/types/remote/mobile';
import type { LiveChatEvent } from '../../socket/streaming/live-stream/events';
import { chatOps } from './diff';

/** Changes are gathered for this long, so a burst of stream chunks becomes one frame. */
const FLUSH_MS = 250;
/** Desktop-wide across every phone, far below the relay's per-route limits on frames and bytes. */
const MAX_FRAMES_PER_SECOND = 4;
/** Frame bodies as sent; a small burst plus the refill keeps any 60 s window within 8 MiB. */
const BYTE_BURST = 1024 * 1024;
const BYTES_PER_MINUTE = 8 * 1024 * 1024 - BYTE_BURST;
/** A bigger frame body is not queued: the phone is told to resync and reads the chat again. */
const MAX_EVENT_BYTES = 64 * 1024;
/** Conversations one phone may watch at once; a newer watch retires the oldest. */
const MAX_WATCHES = 4;
/** Broadcasts that can change what a phone watching a chat shows. */
const WATCHED_CHANNELS = new Set([
  'socket:stream-chunk',
  'socket:execute-complete',
  'socket:stream-settled',
  'socket:error',
  'socket:message-saved',
  'socket:permission-request',
  'socket:permission-response',
  'socket:permission-dismiss',
  'socket:wake-hold-changed',
  'socket:sub-chat-mode-changed',
  'socket:task-signal-persisted',
]);

export type ChatEventEnvelope = Extract<MobileEnvelope, { t: 'evt' }>;
/** Seals one event frame onto a phone's channel; settles once the relay has taken it. */
export type ChatEventSender = (envelope: ChatEventEnvelope) => Promise<void>;
/** Reads the watched chat as the phone's `chat` request does; `subChatId` is set once known. */
type ChatReader = (subChatId?: string) => Promise<MobileChatDetail>;
export type MobileStreamHub = {
  register(channelId: string, send: ChatEventSender): void;
  unregister(channelId: string): void;
  /** Null when `channelId` is not open, or the watch was retired or replaced while it read. */
  watch(
    channelId: string,
    read: ChatReader,
    subChatId?: string,
  ): Promise<{ sub: string; detail: MobileChatDetail } | null>;
  unwatch(channelId: string, sub: string): void;
  dispose(): void;
};
type Subscribe = (listener: (event: LiveChatEvent) => void) => () => void;

type Watch = {
  sub: string;
  /** Creation order: a newer watch of a conversation wins, and the cap retires the oldest. */
  order: number;
  /** Lowest goes next among a channel's watches with changes; renewed after each frame. */
  turn: number;
  read: ChatReader;
  /** Known once the first read names the conversation. */
  subChatId: string | null;
  seq: number;
  /** What the phone holds; null until the watch's first read lands. */
  sent: MobileChatDetail | null;
  dirty: boolean;
  /** Retired while its phone holds it: one final resync is owed, then the watch is removed. */
  ending: boolean;
  /** No event goes out before this, so the watch's own response reaches the phone first. */
  readyAt: number;
};
type Channel = { send: ChatEventSender; watches: Map<string, Watch>; busy: boolean; open: boolean };

/** A token bucket for frames and bytes, shared by every phone. */
class FrameBudget {
  private frames = MAX_FRAMES_PER_SECOND;
  private bytes = BYTE_BURST;
  private at = Date.now();

  take(): boolean {
    const now = Date.now();
    const elapsed = now - this.at;
    this.at = now;
    this.frames = Math.min(
      MAX_FRAMES_PER_SECOND,
      this.frames + (elapsed * MAX_FRAMES_PER_SECOND) / 1000,
    );
    this.bytes = Math.min(BYTE_BURST, this.bytes + (elapsed * BYTES_PER_MINUTE) / 60_000);
    if (this.frames < 1 || this.bytes < MAX_EVENT_BYTES) return false;
    this.frames -= 1;
    return true;
  }

  refund(): void {
    this.frames = Math.min(MAX_FRAMES_PER_SECOND, this.frames + 1);
  }

  spend(bytes: number): void {
    this.bytes -= bytes;
  }
}

function encode(event: MobileChatEvent): string {
  return Buffer.from(JSON.stringify(event)).toString('base64');
}

/** A frame body, and what the phone holds once it is sent; null `sent` ends the watch. */
type NextEvent = { body: string; sent: MobileChatDetail | null };
const RESYNC: NextEvent = { body: encode({ ops: [{ op: 'resync' }] }), sent: null };

/** The next frame for a watch whose phone holds `sent`. A body past the cap, a change the ops
 * cannot express, or an unreadable chat becomes a resync instead. */
async function nextEvent(watch: Watch, sent: MobileChatDetail): Promise<NextEvent | null> {
  let detail: MobileChatDetail;
  try {
    detail = await watch.read(watch.subChatId ?? undefined);
  } catch {
    return RESYNC;
  }
  const patch = chatOps(sent, detail);
  if (!patch) return RESYNC;
  if (!patch.ops.length) return null;
  const body = encode({ ops: patch.ops });
  return body.length > MAX_EVENT_BYTES ? RESYNC : { body, sent: patch.held };
}

/** Whether a broadcast for `subChatId` can change what `watch` shows: its own conversation, or a
 * sibling listed in its chat's state. A broadcast naming none, or a watch not yet read, may too. */
function touches(watch: Watch, subChatId: string | null): boolean {
  if (!subChatId || !watch.sent || subChatId === watch.subChatId) return true;
  return Boolean(watch.sent?.subChats.some((sibling) => sibling.id === subChatId));
}

/** The ready watch with changes or a resync owed that has gone longest without a frame. */
function nextWatch(channel: Channel, now: number): Watch | undefined {
  return [...channel.watches.values()]
    .filter((watch) => now >= watch.readyAt && (watch.ending || (watch.dirty && watch.sent)))
    .sort((left, right) => left.turn - right.turn)[0];
}

/** Pushes changes to phones watching a chat. Each watch is diffed against what its phone was last
 * sent, at most every FLUSH_MS, with one frame in flight per channel. */
class StreamHub implements MobileStreamHub {
  private readonly channels = new Map<string, Channel>();
  private readonly budget = new FrameBudget();
  private readonly unsubscribe: () => void;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  /** Hands out each watch's `order` and every `turn`. */
  private clock = 0;

  constructor(subscribe: Subscribe) {
    this.unsubscribe = subscribe((event) => this.mark(event));
  }

  register(channelId: string, send: ChatEventSender): void {
    this.unregister(channelId);
    this.channels.set(channelId, { send, watches: new Map(), busy: false, open: true });
  }

  unregister(channelId: string): void {
    const channel = this.channels.get(channelId);
    if (!channel) return;
    channel.open = false;
    channel.watches.clear();
    this.channels.delete(channelId);
  }

  async watch(channelId: string, read: ChatReader, subChatId?: string) {
    const channel = this.channels.get(channelId);
    if (!channel) return null;
    const order = this.clock++;
    const watch: Watch = {
      sub: randomUUID(),
      order,
      turn: order,
      read,
      subChatId: subChatId ?? null,
      seq: 0,
      sent: null,
      dirty: false,
      ending: false,
      readyAt: 0,
    };
    channel.watches.set(watch.sub, watch);
    const live = [...channel.watches.values()].filter((other) => !other.ending);
    if (live.length > MAX_WATCHES)
      this.retire(
        channel,
        live.reduce((oldest, other) => (other.order < oldest.order ? other : oldest)),
      );
    let detail: MobileChatDetail;
    try {
      detail = await read(subChatId);
    } catch (error) {
      channel.watches.delete(watch.sub);
      throw error;
    }
    if (channel.watches.get(watch.sub) !== watch) return null;
    watch.subChatId = detail.subChatId;
    watch.sent = detail;
    watch.readyAt = Date.now() + FLUSH_MS;
    // Watching a conversation again replaces the earlier watch of it, whichever read lands first.
    for (const other of channel.watches.values()) {
      if (other === watch || other.ending || other.subChatId !== watch.subChatId) continue;
      if (other.order < watch.order) this.retire(channel, other);
      else if (other.sent) {
        channel.watches.delete(watch.sub);
        return null;
      }
    }
    if (watch.dirty) this.schedule();
    return { sub: watch.sub, detail };
  }

  /** Ends `watch` while its channel stays open. A phone holding it is sent a final resync; one
   * still waiting for its first read is answered with null instead. */
  private retire(channel: Channel, watch: Watch): void {
    if (!watch.sent) {
      channel.watches.delete(watch.sub);
      return;
    }
    watch.ending = true;
    watch.readyAt = Date.now() + FLUSH_MS;
    this.schedule();
  }

  unwatch(channelId: string, sub: string): void {
    this.channels.get(channelId)?.watches.delete(sub);
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    clearTimeout(this.timer);
    for (const channelId of [...this.channels.keys()]) this.unregister(channelId);
  }

  private mark(event: LiveChatEvent): void {
    if (!WATCHED_CHANNELS.has(event.channel)) return;
    let marked = false;
    for (const channel of this.channels.values()) {
      for (const watch of channel.watches.values()) {
        if (!touches(watch, event.subChatId)) continue;
        watch.dirty = true;
        marked = true;
      }
    }
    if (marked) this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.disposed) return;
    this.timer = setTimeout(() => this.tick(), FLUSH_MS);
  }

  private pending(): boolean {
    return [...this.channels.values()].some((channel) =>
      [...channel.watches.values()].some((watch) => watch.dirty || watch.ending),
    );
  }

  private tick(): void {
    this.timer = undefined;
    // The channel that went first goes last next time, so no phone starves the others.
    const [first] = this.channels;
    if (first) {
      this.channels.delete(first[0]);
      this.channels.set(...first);
    }
    for (const channel of [...this.channels.values()]) {
      if (!channel.busy)
        void this.flush(channel).catch((error) => log.warn('[Mobile] Live update failed:', error));
    }
    if (this.pending()) this.schedule();
  }

  /** Sends at most one frame, for the watch next in turn. Its snapshot and seq move on only once
   * the frame is sent; a frame that fails ends the watch with a resync at the same seq. */
  private async flush(channel: Channel): Promise<void> {
    const watch = nextWatch(channel, Date.now());
    if (!watch || !this.budget.take()) return;
    channel.busy = true;
    watch.dirty = false;
    try {
      const event = watch.sent && !watch.ending ? await nextEvent(watch, watch.sent) : RESYNC;
      // A watch retired during the read owes a resync, not this change.
      const stale =
        channel.watches.get(watch.sub) !== watch || (watch.ending && Boolean(event?.sent));
      if (!event || !channel.open || stale) {
        this.budget.refund();
        return;
      }
      this.budget.spend(event.body.length);
      const seq = watch.seq + 1;
      try {
        await channel.send({ t: 'evt', sub: watch.sub, seq, body: event.body });
      } catch {
        this.retire(channel, watch);
        return;
      }
      watch.seq = seq;
      watch.turn = this.clock++;
      if (event.sent) watch.sent = event.sent;
      else channel.watches.delete(watch.sub);
    } finally {
      channel.busy = false;
      if (this.pending()) this.schedule();
    }
  }
}

/** `subscribe` delivers every renderer broadcast; the hub keeps those that change a watched chat. */
export function createMobileStreamHub(subscribe: Subscribe): MobileStreamHub {
  return new StreamHub(subscribe);
}
