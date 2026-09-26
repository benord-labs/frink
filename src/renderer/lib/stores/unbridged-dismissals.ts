/**
 * Persistent per-skill memory of "don't copy this across" for the spawn-time un-bridged prompt
 * (see CopyAcrossPrompt). That toast's only other throttle is a session Set in the main process,
 * so without this it re-nags on every launch. Renderer-owned, local-only (localStorage).
 *
 * Three gestures, modelled on n8n's notification-permission prompt (7-day cooldown, give up after 3):
 *  - an auto-close (the toast timed out, ignored) → snooze only; non-interaction is NEVER intent.
 *  - an active dismiss (close button / swipe) → snooze AND escalate; the MAX_DISMISSALS-th is permanent.
 *  - an explicit "Don't ask again" → permanent immediately.
 * Permanence is only ever reached by repeated or explicit intent — never a single ignored toast.
 */

const KEY = 'unbridged-dismissals';
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_DISMISSALS = 3; // active dismisses before a skill goes permanent

type Entry = { until: number | 'forever'; count: number };
type Store = Record<string, Entry>;

const keyOf = (projectId: string, tool: string, skill: string): string =>
  `${projectId}:${tool}:${skill}`;

function read(): Store {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    // A JSON primitive ('42', 'null') parses fine but isn't indexable — coerce to an empty map
    // so a stray/tampered/old-shape value fails open instead of crashing a read or write.
    return parsed && typeof parsed === 'object' ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

function write(store: Store): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // localStorage unavailable/full: a re-prompt next launch is acceptable — never throw.
  }
}

/**
 * Apply `next` to each skill's entry. A permanent ('forever') entry is left untouched so nothing
 * can downgrade it. ponytail: read-modify-write isn't atomic across windows — two windows
 * dismissing the same skill at once can lose an increment; fine for a nag counter, revisit only
 * if escalation ever drives anything weightier than a toast.
 */
function mutate(
  projectId: string,
  tool: string,
  skills: string[],
  next: (prev: Entry | undefined) => Entry,
): void {
  const store = read();
  for (const skill of skills) {
    const k = keyOf(projectId, tool, skill);
    if (store[k]?.until === 'forever') continue;
    store[k] = next(store[k]);
  }
  write(store);
}

/** True while a skill is snoozed or permanently dismissed. Missing/expired/corrupt → false. */
export function isDismissed(projectId: string, tool: string, skill: string): boolean {
  const entry = read()[keyOf(projectId, tool, skill)];
  if (!entry) return false;
  return entry.until === 'forever' || entry.until > Date.now();
}

/** Auto-close (ignored toast): snooze for the cooldown without escalating toward permanent. */
export function snooze(projectId: string, tool: string, skills: string[]): void {
  mutate(projectId, tool, skills, (prev) => ({
    count: prev?.count ?? 0,
    until: Date.now() + SNOOZE_MS,
  }));
}

/** Active dismiss (close button / swipe): snooze and escalate; the MAX_DISMISSALS-th is permanent. */
export function snoozeOrEscalate(projectId: string, tool: string, skills: string[]): void {
  mutate(projectId, tool, skills, (prev) => {
    const count = (prev?.count ?? 0) + 1;
    return { count, until: count >= MAX_DISMISSALS ? 'forever' : Date.now() + SNOOZE_MS };
  });
}

/** Explicit "Don't ask again": permanent for each skill, now. */
export function dismissForever(projectId: string, tool: string, skills: string[]): void {
  mutate(projectId, tool, skills, (prev) => ({ until: 'forever', count: prev?.count ?? 0 }));
}
