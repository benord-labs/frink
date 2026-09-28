# Frink for iPhone

A native Expo / React Native companion to the Frink desktop app. Start with the Work queue, answer your agent's questions, review and run Flows, or continue a chat. Execution and project files stay on your computer. This package has its own dependencies and lockfile, alongside the desktop and relay packages in the Frink repository.

## Development

Use Bun and Node 22.12 or newer. From this directory:

```sh
bun install --frozen-lockfile
bun start
```

This app uses Expo SDK 57 and a native Markdown renderer, so it needs a development build; Expo Go is not sufficient. Install Xcode and its iOS platform support, then run `bun run ios` (or `bunx expo run:ios --device` for a connected iPhone). Select a development signing team in Xcode when building on a physical device. Rebuild the development app when native dependencies change. App Store submission, TestFlight, and a production distribution pipeline are outside this preview.

Start the desktop app from the repository root with `bun install --frozen-lockfile` and `bun run dev`. Configure an AI provider and a project there before starting a new chat on the phone.

## Connect your computer

1. Install Tailscale on the computer and iPhone and sign both into the same private network. Enable HTTPS certificates in your Tailscale configuration when prompted.
2. In Frink desktop, open **Settings → Mobile** and enable mobile access. The API listens only on `127.0.0.1:43129`.
3. Run `tailscale serve status` on the computer. If port 8443 already serves another app, choose another unused HTTPS port in the following command. Do not replace an existing service:

   ```sh
   tailscale serve --bg --https=8443 http://127.0.0.1:43129
   ```

4. Copy the private HTTPS origin that Tailscale prints, including `:8443`, into Frink's Mobile settings. Generate a pairing code.
5. In the iPhone app, scan the pairing QR code or paste the copied pairing JSON. Check the computer's address and tap **Connect to Frink**. Pairing expires after five minutes and can be used once.

Keep Frink open with a loaded window, the computer awake, and Tailscale connected on both devices. Flows use the desktop's existing scheduler and execution pipeline. No SSH key, Frink account, hosted relay, or copied cloud workspace is needed.

This uses **Tailscale Serve** for private HTTPS access. Do not use public Tailscale Funnel for this setup. To remove only this forwarding route, run `tailscale serve --https=8443 off` with the port you selected.

## Use and recovery

- **Queue:** search work, filter to decisions or running work, and open the exact question or permission needing attention. The Queue tab shows how many decisions are waiting for you, from any tab. Answer structured and free-text questions; allow or deny supported pending tool requests.
- **Flows:** search automations, read the current definition's steps, branches, loops and instructions, and inspect individual runs separately. Read a plan before approving it, skip supported failed steps, start or stop a run, or enable/disable its automation. Edit the canvas and retry failed steps on desktop.
- **Chats:** search recent conversations, read formatted replies and code, copy messages, and expand compact tool activity summaries. Load earlier messages without losing your place, return to the latest reply, stop an active response, or start a chat in an existing project using the desktop's configured provider.
- Pull to refresh lists. Connection failures retain the last loaded content and show when it was updated; retry with the refresh button. Only the visible screen polls while the app is foregrounded.
- Revoke a phone from desktop Mobile settings. Disabling mobile access revokes all phones. A revoked phone must pair again.
- Unsent messages and question answers survive navigation and connection errors within the current app session. Closing the app or disconnecting clears them. Commands are never automatically retried. After an uncertain response, refresh and check the computer's state before sending again.

The phone credential lives in the iOS Keychain on this device only. Desktop stores credential digests in its private app data. Sharing a pairing code grants control of this Frink instance; treat the code like an invitation to your computer.

## Validation

```sh
bun run check
bun run test
bunx playwright install chromium
bun run test:ui
bun run export:ios
```

The UI tests run the React Native web rendering at phone sizes against a mock desktop API. `bun run web` is for that preview: browser-origin requests are deliberately rejected by the real desktop bridge, and web preview credentials are kept only in memory. An iOS bundle export validates bundling, not native compilation or device behavior.

The desktop bridge and domain tests are part of the repository-root `bun run test:run:coverage` suite. Mobile CI runs its own type check, transport tests, phone UI tests, and iOS bundle export.

## MVP boundaries

Foreground polling refreshes the queue, runs, and chats. There are no push notifications, offline execution, Flow canvas editing, terminal access, or attachment upload. Complex presentation/consent requests remain on desktop. A sleeping or disconnected computer cannot execute work. Transcripts render Markdown and tool names/status, with full tool inputs and outputs available on desktop. Remote images and embedded HTML are not loaded. The Flow outline describes the current definition, not a historical run snapshot. A definition the desktop's own validator rejects (for example an unfinished Flow with no trigger), or one above 2,500 connections or 512 KiB of text, is shown as unavailable and must be reviewed on desktop; it is never partly shown.

Before release, validate on an iPhone: swipe-back navigation, the keyboard and composer on a long conversation, Dynamic Type and VoiceOver, Reduce Motion/Transparency, Markdown selection and code copying, and background/resume while Tailscale reconnects. Browser screenshots and the JavaScript export do not prove these native behaviors.

The mobile implementation and Frink styling are original to this repository. Other applications informed the connection research; their application code and assets were not copied. Package dependencies retain their own licenses.
