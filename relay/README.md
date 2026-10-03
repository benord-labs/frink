# Frink relay

A tiny public address that catches webhooks for you and hands them straight to your Frink desktop app.

Services like Shortcut or Linear can only send an event to an address they can reach on the internet.
Your laptop usually isn't one. The relay is that address. It takes the delivery, passes the exact
bytes to whichever app is holding the matching key, and forgets it happened.

## What it is not

- **Not a mailbox.** If your app isn't connected at that moment, the delivery is dropped. There is no
  queue, no retry, no replay, nothing written to disk.
- **Not a gatekeeper.** It cannot check a webhook's signature, because it never sees your signing
  secret. Your desktop app does that check itself, on the exact bytes the relay forwarded.
- **Not an account system.** No database, no sign-in, no user records, no API keys.

## The two secrets

Each endpoint has two independent secrets, and they never mix:

- **The subscribe key (K)** — how your app claims deliveries. K is 32 random bytes written as 64
  hexadecimal characters, and the public part of the address is `sha256(K)` in hex, so anyone can see
  the address without being able to claim its deliveries. Your app sends K to the relay when it
  connects, so whoever runs the relay learns K.
- **The signing secret (S)** — how your app proves a delivery really came from the vendor. It only
  ever travels between your machine and the vendor. The relay never sees it.

Losing K costs you the stream: someone could take your deliveries. It does **not** let anyone forge
one. Because the relay learns K, changing the address the app uses means a new K, a new address, and
re-pasting that address at the vendor.

Two providers (Cloudflare and Hugging Face) authenticate by putting the secret itself in a header, so
any relay in the path reads it. Send those through your own tunnel instead.

## Run it locally

```bash
cd relay
bun install
bun run build
RELAY_TRUSTED_PROXY_HOPS=0 node dist/index.js   # nothing in front of it; PORT=8787 by default
```

No database, no secrets, and one setting (below). Then tell the desktop app where webhooks
reach your Frink: start it with `FRINK_WEBHOOK_BASE_URL=http://127.0.0.1:8787`.

## Which address the desktop app uses

`FRINK_WEBHOOK_BASE_URL`, and nothing else. Leaving it unset uses Frink's relay in every build
alike — dev, QA and release — so a fresh install receives deliveries with nothing configured.
Setting it to a blank value is how you ask for the opposite: the app skips the relay entirely and
only listens on your own machine. A variable that is set but is not a plain `https://` address
(or `http://` on localhost) is refused outright rather than falling back to Frink's relay, and boot
logs why. Set it somewhere that outlives a restart: a login-scoped `launchctl setenv` is forgotten
at logout, and the next launch resolves Frink's relay and moves every address onto it.

Changing it from one address to another re-mints every trigger address: the app deletes the
subscriptions it registered at each vendor and every address has to be set up there again. Blank
and refused both resolve to no address at all, which is not a move: nothing is deregistered and
every endpoint stays armed on the base it was minted against, which still holds its subscribe key.
Take those down from each plugin's Triggers card while the variable still points at that relay,
before you retire it.

## Self-host it on Railway

Create a Railway service from this folder; `railway.toml` already sets the build, the start command
and the `/health` check. Set `FRINK_WEBHOOK_BASE_URL` on the desktop app to the service's public URL.

**Run exactly one instance.** The rate limits are counted in the process's own memory, so two
instances would quietly double every limit.

## Counting the proxies in front of it

Some of the limits are counted per caller, so the relay has to work out who the caller really is.
Anything between it and the internet — Railway's own edge, a CDN, a tunnel — hides the caller's
address and writes it into the `X-Forwarded-For` header instead. That header is a list, callers can
put whatever they like at the front of it, and only the entries your own proxies added at the end
can be believed.

`RELAY_TRUSTED_PROXY_HOPS` is how many of those end entries are yours. It defaults to `1`, Railway's
one edge — count up from there for each extra thing you put in front of it yourself, and set it to
`0` when there is nothing in front at all, as when you run `node dist/index.js` on your own machine
or a bare server. Set it too high and a caller can write the header itself and claim to be any
address it likes, giving itself a fresh budget per connection and dodging the limits entirely; set
it too low and everyone behind your proxy is counted as one caller and they share a single budget.

## What it answers

| Request | Answer |
| --- | --- |
| `POST /api/triggers/:provider/:token` | Always `202 {"status":"accepted"}` — whether or not anyone is listening, and whether or not the address is real. |
| the same, over 1 MiB | `413` — everything past the first 1 MiB is thrown away as it arrives, so an oversized body is never held in memory. |
| the same, over 60 per minute for one address | `429`, counted per address rather than per sender. |
| `GET /health` | `200` |

A connected app sends `subscribe` with `{ key }` over the socket, where `key` is K in its 64-character
hex form; the relay joins it to the room named `sha256(key)`. Anything that is not 64 hex characters is
ignored, and a wrong key simply joins a room nobody delivers to — there is no error that tells an
attacker they were close. Subscribe attempts are capped at 20 per minute per address of origin and 20
per connection.

The reply is deliberately always the same, and it arrives before your desktop app has judged the
delivery. That means a vendor sees green even when your app rejected the body, and a vendor that
retries on failure will not retry. The Triggers card in the app is where a rejection shows up.

Logs carry request counts and drops only — never a body, a header value, an address or a key.

## Mobile companion

The `/mobile` Socket.IO namespace joins an outbound desktop connection to its paired phones,
including phones on cellular or other Wi-Fi. Both sides use WebSocket transport over HTTPS
(`transports: ['websocket']`, `forceNew: true`). Native phones also send
`extraHeaders: { 'X-Frink-Mobile': '1' }` because iOS and Android add Origin automatically.
No inbound desktop port or account is needed.
Mobile data is encrypted end to end; this relay only forwards opaque binary frames. The desktop
and phone own the encryption, pairing expiry and access checks. A relay operator can observe IPs,
routes, connection times and byte lengths, or disrupt delivery, but cannot authenticate as a
paired device or decrypt its data. The desktop key pinned by the QR authenticates the other end.

The desktop connects with `auth: { role: 'desktop', key }`, where `key` is 32 random bytes encoded
as 64 lowercase hex characters. Its public route is `sha256(key)` of that UTF-8 string, also hex.
The relay learns this routing key; it is **not** an encryption or pairing credential. A phone uses
`auth: { role: 'phone', route }`. A new holder of the same routing key replaces the old desktop
connection and closes its phones, so switching networks does not wait for a stale socket to expire.
The QR carries the route, never the routing key. A phone cannot connect while its desktop is offline.

| Direction | Event and arguments |
| --- | --- |
| Phone → relay → desktop | `frame(data, ack)` → `frame({ peerId, data }, ack)` |
| Desktop → relay → phone | `frame({ peerId, data }, ack)` → `frame(data, ack)` |
| Relay → desktop | `peer-connected(peerId)`, `peer-disconnected(peerId)` |
| Desktop → relay | `disconnect-peer(peerId)` cuts that phone off immediately |

`data` is a binary frame of at most 256 KiB, enforced by Engine.IO before namespace dispatch.
Each receiver calls `ack()` after accepting the frame;
the relay then acknowledges the sender with `true`. Senders serialize frames and await each ack
(use a timeout above the relay's 15 seconds). No response causes that phone to be disconnected.
Large requests and responses, including attachments, must be fragmented by the endpoints.
Desktop disconnect closes every phone connection. Reconnection requires a fresh encrypted session;
there is no offline queue, request replay, or persisted routing state.

The process caps raw Socket.IO connections at 4096 globally and 128 per origin IP (including the
existing webhook namespace), and connection attempts at 60 per IP per minute. Mobile additionally
caps namespace admissions at 60 per IP per minute, phones at 20 per route, frames at 2048 per
sender per minute, ciphertext at 64 MiB per route per minute in both directions combined, and
unacknowledged frames at eight per phone. Rate-limit maps are bounded and reset every minute.
Origin headers without the native marker and non-WebSocket mobile transports are rejected. The
marker is browser abuse friction only; it grants no access to the desktop. Proxy-origin accounting
uses the same `RELAY_TRUSTED_PROXY_HOPS` setting as webhooks. These are process-local limits:
continue to run exactly one instance. A relay restart drops connections; clients reconnect.

The desktop app reaches Frink's relay for mobile unless `FRINK_MOBILE_RELAY_URL` names another
one, as a bare `https://` origin. It never follows `FRINK_WEBHOOK_BASE_URL`, which may point at a
webhook tunnel that has no `/mobile` namespace.
