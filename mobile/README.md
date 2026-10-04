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
3. On the same network, start Metro with `bun run dev` and open Frink Dev.

Saving a file updates the phone in about a second. The TestFlight app is built with `bunx eas-cli build -p ios --profile production`.

Frink Dev loads from port 8081 by default, so run Metro on 8081 only from the checkout you want on your phone (normally your main checkout). To preview a worktree, start its Metro on another port, such as `bun run dev -- --port 8082`, and enter that address in Frink Dev. **Your computer** in the app shows the checkout, branch and commit the running code came from.

Start the desktop app from the repository root with `bun install --frozen-lockfile` and `bun run dev`. Configure an AI provider and a project there before starting a new chat on the phone.

## Connect your computer

1. In Frink desktop, open **Settings → Mobile** and turn on mobile access.
2. In the iPhone app, scan the QR code or paste the copied pairing link. Confirm your Mac and tap **Connect**. Each code works once, for five minutes.

One iPhone can pair with several computers. Add another from **Settings → Computers → Add a computer**, or by scanning its code; the computers already paired stay paired. Tap a computer in that list to switch to it. Only the computer on screen is refreshed. Alerts keep arriving from every paired computer, and tapping one opens that computer's chat. If iOS gives this iPhone a new push token, a computer learns it the next time you switch to it, and its alerts resume then. If a computer's mobile access was reset, scanning its new code offers to replace its old pairing. The Lock Screen card shows the computer on screen.

The connection works over cellular or other Wi-Fi networks. Keep Frink open with a loaded window and the computer awake and online. Both devices connect out to Frink's relay; no account or network setup is needed. Your phone pins the desktop's encryption key from the QR. The relay forwards encrypted frames and cannot read prompts, files, credentials or responses. It sees routing identifiers, IP addresses, traffic sizes and timing; it can interrupt connectivity.

## Use and recovery

- **Queue:** see work needing attention and open its chat or Flow. Answer structured and free-text questions; allow or deny supported pending tool requests.
- **Flows:** inspect runs and step output, read a plan before approving it, skip supported failed steps, start a run, stop it, or enable/disable its automation. Retry failed steps on desktop.
- **Chats:** continue conversations, load earlier messages, stop an active response, and start a chat in an existing project using the desktop's configured provider.
- Revoke a phone from desktop Mobile settings. Disabling mobile access revokes all phones. A revoked phone must pair again.
- Connection errors preserve the current draft. Commands are never automatically retried. After an uncertain response, refresh and check the computer's state before sending again.

The phone credential lives in the iOS Keychain on this device only. Desktop stores credential digests and its channel identity in its private app data. Sharing a pairing code grants control of this Frink instance; treat the code like an invitation to your computer.

## Alerts

In the iPhone app, open **Settings → Notifications** and turn on **When a chat finishes**, then allow notifications when iOS asks. When an ordinary chat finishes successfully, Frink on your computer sends a short alert, including while the app is in the background or the phone is locked. Tap it to open that chat. Stopped, failed and superseded turns, and individual Flow steps, send no alert. The computer must be awake and online with mobile access enabled.

The alert is sent once the chat is really finished. A chat still waiting on background work, such as a test run it is watching, alerts after its final reply and not each time that work wakes it. Frink also holds alerts while you are using the Mac with Frink in front: a chat you saw finish there sends nothing, and one that finishes after you step away alerts once the Mac has had no input for two minutes. With another app in front, alerts go to the phone straight away.

Frink also alerts when a chat needs you: a question, a permission request, a plan to review, or a task waiting on you. One you answer at the Mac never reaches the phone; one still open when you leave it does.

Alerts go through Expo's push service to Apple. Only a fixed message naming the kind of alert (a chat finished, has a question, needs a permission, has a plan ready, or a task needs you) and opaque pairing and chat ids leave the computer; prompts, code, chat titles and credentials never do. Delivery is best effort: a failure the computer sees is shown under the switch. Turning the switch off or removing the phone in desktop Mobile settings stops future alerts. Forgetting the Mac on the phone stops them too when the Mac is reachable; otherwise that takes effect when you pair again or remove the phone on the desktop. An alert already accepted by the push service may still arrive.

`expo-notifications` is a native module, so the app must be rebuilt after it is added; a Metro reload is not enough. Before the first build with it, create an Apple Push Notifications key and let EAS store it: run `bunx eas-cli credentials -p ios`, choose the build profile, and set up **Push Notifications** for the bundle id (`dev.frink.mobile.dev` for Frink Dev, `dev.frink.mobile` for TestFlight). EAS then regenerates the provisioning profile with the push entitlement on the next `bunx eas-cli build -p ios --profile development` (or `production`). The key stays in EAS; never put it or an Expo access token in the desktop app.

To verify on a physical iPhone: install the rebuilt app, turn alerts on, start a chat, lock the phone, and check that an alert arrives and opens the right chat. Also check turning alerts off and removing the phone on the desktop. A bundle export or a push ticket alone does not prove delivery.

## Validation

```sh
bun run check
bun run test
bunx playwright install chromium
bun run test:ui
bun run export:ios
```

The UI tests run the React Native web rendering at phone sizes through the real encrypted phone transport against a mock relay and desktop API. `bun run web` is for that preview: browser-origin requests are deliberately rejected by the real desktop bridge, and web preview credentials are kept only in memory. An iOS bundle export validates bundling, not native compilation or device behavior.

The desktop bridge and domain tests are part of the repository-root `bun run test:run:coverage` suite. Mobile CI runs its own type check, transport tests, phone UI tests, and iOS bundle export.

### Review on the iOS simulator against fixture data

The web preview has no native navigation bar or menus, so judge layout on the simulator. `tests/fixtures/sim-relay.ts` stands in for a Mac: it speaks the phone's real channel protocol over TLS on 127.0.0.1 and answers with the UI tests' fixture data. Use a simulator that is not paired to your real Mac, since pairing replaces that pairing.

```sh
mkdir -p /tmp/frink-sim-relay && cd /tmp/frink-sim-relay
openssl req -x509 -newkey rsa:2048 -nodes -days 365 -keyout key.pem -out cert.pem \
  -subj "/CN=Frink fixture relay" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "extendedKeyUsage=serverAuth"
xcrun simctl keychain <udid> add-root-cert cert.pem
cd - && SIM_RELAY_PORT=18443 bun tests/fixtures/sim-relay.ts   # prints the pairing link
xcrun simctl openurl <udid> "<printed frink-mobile://pair link>"
```

The desktop key is saved beside the certificate, so restarting the relay keeps the pairing. Requests that change something are appended to `/tmp/frink-sim-relay/requests.log`.

## MVP boundaries

Foreground polling refreshes the queue, runs, and chats; the only push alerts are the ones above. There is no offline execution, Flow canvas editing, terminal access. Complex presentation/consent requests remain on desktop. A sleeping or disconnected computer cannot execute work. Transcripts display text; rich tool cards remain available on desktop.

The mobile implementation and Frink styling are original to this repository. Other applications informed the connection research; their application code and assets were not copied. Package dependencies retain their own licenses.
