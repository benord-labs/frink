# Frink for iPhone

A native Expo / React Native companion to the Frink desktop app. Start with the Work queue, answer your agent's questions, review and run Flows, or continue a chat. Execution and project files stay on your computer. This package has its own dependencies and lockfile, alongside the desktop and relay packages in the Frink repository.

## Development

Use Bun and Node 22.12 or newer. From this directory:

```sh
bun install --frozen-lockfile
```

The app uses native modules (Markdown, photo and file pickers), so Expo Go cannot run it. Develop with **Frink Dev**, a development build that installs beside the TestFlight app (bundle `dev.frink.mobile.dev`) and loads JavaScript live from your Mac:

1. Register your iPhone once: `bunx eas-cli device:create`, then open the link on the phone. Turn on Settings → Privacy & Security → Developer Mode.
2. Build Frink Dev in the cloud: `bunx eas-cli build -p ios --profile development`, then install it from the link EAS prints. Rebuild only when native dependencies, permissions or the app icon change.
3. Start Metro and open Frink Dev:
   - Same network: `bun run dev`
   - Anywhere on your tailnet: `bun run dev:tailnet` (serves Metro privately over Tailscale HTTPS on port 8444)

Saving a file updates the phone in about a second. The TestFlight app is built with `bunx eas-cli build -p ios --profile production`.

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

- **Queue:** see work needing attention and open its chat or Flow. Answer structured and free-text questions; allow or deny supported pending tool requests.
- **Flows:** inspect runs and step output, read a plan before approving it, skip supported failed steps, start a run, stop it, or enable/disable its automation. Retry failed steps on desktop.
- **Chats:** continue conversations, load earlier messages, stop an active response, and start a chat in an existing project using the desktop's configured provider.
- Revoke a phone from desktop Mobile settings. Disabling mobile access revokes all phones. A revoked phone must pair again.
- Connection errors preserve the current draft. Commands are never automatically retried. After an uncertain response, refresh and check the computer's state before sending again.

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

Foreground polling refreshes the queue, runs, and chats. There are no push notifications, offline execution, Flow canvas editing, terminal access, or attachment upload. Complex presentation/consent requests remain on desktop. A sleeping or disconnected computer cannot execute work. Transcripts display text; rich tool cards remain available on desktop.

The mobile implementation and Frink styling are original to this repository. Other applications informed the connection research; their application code and assets were not copied. Package dependencies retain their own licenses.
