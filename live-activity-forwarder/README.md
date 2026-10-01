# Frink Live Activity forwarder

The Lock Screen card on the Frink iPhone app shows how many agents are running and how many need
you. Only Apple can change that card while the phone is locked, and Apple only takes the change
from a server holding Frink's push key. This Cloudflare Worker is that server. The desktop app
sends it two numbers, and it passes them on to Apple.

## What it is not

- **Not a store.** No database, no accounts, and it keeps nothing it forwarded.
- **Not a reader.** It only ever sees two counts and the card's push token. Chat names and
  contents never leave your Mac.
- **Not a gatekeeper.** There is no login. The card's push token is the only thing that lets a
  request through: the phone makes it up, it expires within 8 hours, and it only travels
  phone → your Mac → here → Apple.

## The request

`POST /live-activity`, `Content-Type: application/json`, at most 512 bytes, exactly these fields:

```json
{ "token": "<64-400 lowercase hex>", "event": "update", "running": 3, "needsYou": 1, "urgent": true }
```

`event` is `update` or `end`, and both counts are whole numbers from 0 to 999.

| Answer | Meaning |
| --- | --- |
| 200 | Apple took it. |
| 410 | The card is gone. Stop sending to this token. |
| 429 | Too many requests. Try again after `retryAfter` seconds. |
| 400 | The request was not the shape above. |
| 502 | Apple refused the push for another reason, usually a key or topic mistake. |

Each token may send once every 5 seconds and 60 times an hour, and one Worker instance passes on
at most 300 a minute.

## Deploy your own

You need an Apple Developer account and a Cloudflare account.

1. In Apple Developer, go to **Keys**, add a key with **Apple Push Notifications service (APNs)**,
   choose **Production** and **Topic-specific**, and pick your app's bundle id. Download the
   `.p8` file. Apple only lets you download it once.
2. If you forked the app, change `TEAM_ID` and `TOPIC` in `src/apns.ts` to your team id and
   `<your bundle id>.push-type.liveactivity`.
3. Deploy:

   ```bash
   cd live-activity-forwarder
   npm ci
   npx wrangler@4.144.0 login
   npx wrangler@4.144.0 secret put APNS_KEY_ID                   # the key's 10-character id
   npx wrangler@4.144.0 secret put APNS_PRIVATE_KEY < AuthKey_<ID>.p8
   npm run deploy
   ```

   Secrets are write-only: nobody can read the key back out of Cloudflare, so keep the `.p8` in
   a password manager.

4. Put `<your workers.dev address>/live-activity` into `LIVE_ACTIVITY_URL` in the desktop app.

## Check it works

```bash
URL=<your workers.dev address>/live-activity
curl -i -X POST "$URL" -H 'content-type: application/json' -d '{}'   # 400
curl -i -X POST "$URL" -H 'content-type: application/json' \
  -d "{\"token\":\"$(printf '0%.0s' {1..64})\",\"event\":\"update\",\"running\":1,\"needsYou\":0,\"urgent\":false}"   # 410
```

The second request gets **410** because Apple accepted your key and topic, then rejected the
made-up token. A **502** means the setup is wrong: the Worker's logs in the Cloudflare dashboard
show Apple's reason, such as `InvalidProviderToken` or `TopicDisallowed`.

## Tests

From the repository root: `bun run test:run -- live-activity-forwarder`.
