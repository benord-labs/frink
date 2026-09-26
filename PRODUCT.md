# Product

## Register

product

## Users

Everyone who does dev-shaped work, spanning two audiences on one product:

- **First-timers / non-developers** doing a small coding or automation task without wanting to be (or babysit) a developer. They start in a chat, expect sensible defaults, and don't read jargon.
- **Developers / power users** orchestrating parallel agents, trigger-based automation, and multi-step Flows (conditions, worktree isolation).

Context of use: a desktop app (Electron, Mac/Windows) that lives alongside the user's real machines, repos, and tools. The user is in a *task* — kicking off work, reviewing an agent's output, wiring an automation — not browsing. Work is local-first and BYO-provider; Frink runs on the user's machine with their own Claude CLI.

The job to be done: *get a dev task done without the overhead of being a developer* — from a one-off chat up to a repeatable, triggered, parallel-agent Flow.

## Product Purpose

Frink is a friendly AI development tool for everyone: easy enough for a first-timer to complete a small coding/automation task, powerful enough for a pro to orchestrate parallel agents and complex Flows. It triggers automatically (Shortcut ticket, starred email, Slack mention), remembers preferences, and queues work for human review before anything ships.

The differentiator is the **friendly ladder on one spine**: easy rung (chat, defaults) → on-ramp ("save this chat as a Flow") → power rung (triggers, conditions, parallel agents). Success is a user climbing that ladder without ever hitting a cliff — and trusting Frink with the next rung because the last one was clear.

The hard line (what keeps Frink a tool, not a platform): Frink never hosts the user's *shipped product* backend — their DB, payments, auth, deploy. That's the Lovable lane. Frink's own infra is fine; the user's end-product's is out.

## Brand Personality

**Friendly base, pro density.** Approachable, calm, plainspoken on the surface; dense and precise where power users live. Warmth comes from clarity and restraint, not decoration. Named after Professor Frink (The Simpsons), the mad scientist who over-engineers everything — held as self-aware irony, not as a mascot: the product's actual value is *keeping it simple*.

Three words: **friendly, capable, honest.**

Voice: direct, low-jargon, verb-first. Tells the user what's happening (an agent is running, work is queued for review, a permission is needed) without hiding state behind chrome. Confident without showing off; the tool earns trust by disappearing into the task, then revealing depth only when the user reaches for it.

## Anti-references

The UI must NOT look like any of these:

- **Generic AI-SaaS slop** — cream/sand backgrounds, gradient text, tiny uppercase tracked eyebrows over every section, identical icon-card grids, the hero-metric template. The saturated 2026 AI default.
- **Cold terminal / IDE** — pure-black hacker aesthetic, neon-on-black, monospace everything, intimidating dev-tool coldness. It contradicts "friendly for everyone."
- **Toy / childish** — over-rounded cartoon shapes, heavy mascot/emoji, bright toy-primary palette. The Professor Frink reference is *irony*, never literal whimsy that undercuts pro trust.
- **Cluttered enterprise** — gray-on-gray legacy dashboards, every pixel a control, no breathing room.

The target sits between these: friendlier and calmer than Cursor/Conductor/a raw IDE, more precise and trustworthy than a no-code toy, never a hosted app-builder (Replit/Bolt/Lovable).

## Design Principles

1. **The ladder is visual.** Every surface must read at the easy rung and the power rung. Sensible defaults and a clear on-ramp for newcomers; full density (Flows, parallel agents, conditions) for pros — without a cliff between them. Never gate a basic task behind pro complexity, never dumb down the power surface.
2. **Friendly, not toy; capable, not cold.** Warmth is carried by clarity, calm spacing, and plain language — not mascots, not decoration. Trust is carried by precision and consistency — not terminal coldness. Earned familiarity over novelty.
3. **The tool disappears into the task.** Product-register craft: standard affordances for standard tasks, consistent component vocabulary screen to screen, motion that conveys state and nothing else. Delight lives in moments, not on every page.
4. **Keep it simple (the Frink irony).** Resist over-engineering the interface. Fewer affordances, fewer states to learn, the shortest path to done. The best UI is the one the user doesn't have to think about.
5. **Show state honestly; human stays in the loop.** Agents run, work queues, permissions are requested — make all of it legible. Never hide what an agent is doing or auto-ship without a clear review surface. Trust depends on visible truth.

## Accessibility & Inclusion

- **WCAG 2.2 AA** as the floor: body text ≥4.5:1 contrast (≥3:1 for large/bold), full keyboard operability, visible focus states, labeled form controls. Enforced in spirit by the project's frontend-accessibility-reviewer.
- **Motion safety is non-negotiable:** every animation ships a `prefers-reduced-motion: reduce` alternative (crossfade or instant). Motion conveys state, never gates content visibility.
- Light + dark themes both meet AA (the app ships `next-themes`); contrast verified in both.
- State is never encoded by color alone where it carries meaning (pair with icon/text/shape) so the interface holds up for colorblind users even though it isn't a hard gate.
