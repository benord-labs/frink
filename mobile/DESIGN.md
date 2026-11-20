# Frink mobile: reference-led redesign

## Intent

A calm, compact companion for conversations and agent work. Savee supplies the
restraint and content density; ChatGPT supplies the conversation and composer
hierarchy. Frink supplies its existing neutral palette, muted violet, semantic
work states, projects, Flows and paired-computer model.

## Observed references

Gummble screens inspected on 4 October 2026. Savee's capture is from May 2026;
ChatGPT's is from June 2025. These are catalogue references, not current-version
claims. Measurements are visual estimates at a 390 by 844 logical viewport.

- [Savee discovery](https://gummble.com/screens/sc_ddc1fbec70594adf8fa615fd7d9d3842):
  search and a compact category row; useful content starts near y189. No stacked
  branding, heading and create banner.
- [Savee search](https://gummble.com/screens/sc_bebcfe1f03304799880ac78e8d1ccec5):
  ordinary text tabs with a thin selected underline.
- [Savee settings](https://gummble.com/screens/sc_8dd5ee73fbaa481a8c3e605c559e0934):
  compact centred title, flat rows, restrained secondary labels.
- [ChatGPT history](https://gummble.com/screens/sc_c6ca4d214f284e4c81ee4aa0958daed7):
  plain 16pt conversation titles, approximately 48pt row pitch, muted group labels.
- [ChatGPT conversation](https://gummble.com/screens/sc_a7ff8aae1d3e4c6e9048ab0b2bdb5d41):
  one compact navigation bar, unboxed assistant prose and quiet user bubbles.
- [ChatGPT composer](https://gummble.com/screens/sc_af87553667a34d59a4ca4f3b6f696a33):
  text above a compact tools row, small circular send action, directly above the
  keyboard. The writing surface grows for actual text and attachments.

## Implementation contract

1. Chats, Flows and Queue are tabs, each with its own stack: the system tab bar on iOS,
   a JavaScript tab bar in the web preview. Launch opens Chats and reopens the last
   conversation once. Recent and Projects preserve search, paging, project creation and
   swipe deletion. The tab bar hides inside a conversation, whose header keeps the Queue
   button and needs-you badge. Tab roots use native large titles and, on iOS, the header
   search bar; the web preview keeps a search field in the page. Pushed pages use the plain
   stack title. The computer button on each tab root, the one place that names the computer,
   opens Settings as a sheet.
2. Retain visible grouping: Queue and Settings use inset translucent groups with
   the desktop rim. Chats rows stay compact, with an explicit selected fill.
   Assistant prose remains unboxed; user messages use the shared glass material.
3. The composer uses Frink glass, a 25pt radius, a small send button and a compact
   tools row. Project and mode sit above it. Root launch leaves the keyboard closed.
   Drafts, attachment ownership and measured keyboard behavior retain their handlers.
4. Five stored transparency levels reproduce desktop fill, rim, sheen and violet
   glint tokens. Web uses desktop blur/saturation; native Expo blur maps the same
   0/10/8/6/5px steps to intensity 0/50/40/30/25. Tint and lighting remain shared.
   OS Reduce Transparency overrides the level with solid material. Atmosphere stays fixed.
5. Preserve selected-computer ownership, notifications, live Queue counts, semantic
   green/amber/red states and all named commands. Settings lists paired computers in one
   group: the shown one ticked with its status, then Add a computer and Forget this computer.
   The Queue tab's badge counts what needs you. Copy says "computer", never a platform. Opening a review preserves its
   return route. Tabs out of view leave the page, so screen readers reach only the shown tab.

## Verification

Run the existing mobile typecheck, relevant tests, browser interaction suite and
native iOS export. Inspect the actual native Simulator for header/search insets,
content density, small controls with usable hit targets, software keyboard,
large text, light/dark appearance and first-tap search results. Use a dedicated
worktree preview on port 8082; the main checkout owns port 8081.
