# Releasing Frink

There are two release paths, and both upload to the same R2 bucket through
`scripts/publish/upload-to-r2.mjs`:

| Platform | How | Where |
|----------|-----|-------|
| macOS (arm64 + x64) | Locally: `bun run release` | Your machine, reads `.env` |
| Windows, Linux | Push a version tag | `.github/workflows/build-desktop.yml` |

Before building, both paths run `scripts/publish/assert-release-env.mjs`, which fails the release if
the auto-update feed is missing or unusable. An official build without a feed ships with
auto-update turned off. The only way for its users to get updates is a build that knows the feed,
so they would be stranded on that version. See [update-feed-ownership](decisions/update-feed-ownership.md).

## Linux

The tag build publishes both architectures:

- x64, built on `ubuntu-latest`: `Frink-<version>.AppImage`, `frink_<version>_amd64.deb` and
  `latest-linux.yml`.
- arm64, built on `ubuntu-24.04-arm`: `Frink-<version>-arm64.AppImage`,
  `frink_<version>_arm64.deb` and `latest-linux-arm64.yml`.

electron-builder writes one feed per Linux arch, and electron-updater reads the one for
`process.arch`, so the two legs share the bucket without a clash.

Both formats auto-update from that feed:

- **AppImage** replaces itself in place. The new file goes over the running `$APPIMAGE`, or is
  saved under the new version's name if the old file name had a version in it. This needs a
  folder the user can write to.
- **.deb** updates through a polkit prompt. Because `build.publish` is set, electron-builder writes
  `resources/package-type` = `deb` into the package, so electron-updater uses its `DebUpdater`.
  That takes the `.deb` listed in the same feed and installs it with `dpkg -i`, falling back to
  `apt-get install -f`. It runs this through the first of `gksudo`, `kdesudo`, `pkexec` or
  `beesu` that it finds, which on a normal desktop is `pkexec`. With none of them it falls back
  to plain `sudo`, which cannot prompt from a GUI, so the user has to install the update by hand.

This replaces the earlier [windows-support](decisions/windows-support.md) note that called .deb
updates manual. The decision log records the correction as its 2026-10-05 note. Only the Windows
portable build is updated by hand.

## Bumping a provider

Frink runs each agent provider behind its own config folder, so a setting a provider update adds
can work in the terminal and do nothing inside Frink. Every pin below has a check that fails until
someone decides what each change means for Frink.

| Provider | Pin | Check that fails |
|----------|-----|------------------|
| Claude CLI | `scripts/binaries/claude-cli-version.json` | `cli-pin.test.ts` in `src/main/lib/claude/settings-contract/`: the CLI must not be older than the Agent SDK's `claudeCodeVersion`, or more than 25 patches newer. |
| Claude Agent SDK | `@anthropic-ai/claude-agent-sdk` in `package.json` (exact) | `bun run ts:check`: `CLAUDE_SETTINGS_CONTRACT` in `src/main/lib/claude/settings-contract/index.ts` must route every top-level key of the SDK's `Settings`. |
| Codex | `patches/codex/manifest.json` | `codex:build` and CI `--test-only`: `patches/codex/thread-item-variants.json` and `patches/codex/config-surface.json` must match the pinned source. `spawn-args.test.ts` checks that the features Frink turns off are the ones routed `disabled-by-frink`. |
| Cursor | `@cursor/sdk` in `package.json` | `cursor-launch.test.ts`: must equal `CURSOR_ROW.sdk.version`. `ts:check`: `CURSOR_SETTING_SOURCES` must route every `SettingSource`. |
| Copilot | `@github/copilot-sdk` in `package.json` | `ts:check`: `COPILOT_SESSION_OPTIONS` in `copilot-session.ts` must route every session option. |

The Claude CLI ships at exactly the pinned version: `bun run claude:download` reads it, and every
release and CI build runs that script. `--version=X` is for trying a CLI by hand.

To bump:

1. Change the pin. Bump the Claude CLI and the Agent SDK together once the CLI is too far ahead.
2. Run `bun run ts:check` and the tests. Each failure names the provider, the version, and every
   added, removed or changed key.
3. Route each new key in the file the failure names. A route is one honest line:
   - `delivered`: Frink carries the user's own value into every chat;
   - `frink-owned` / `frink-sets`: Frink sets it itself, from its own settings or policy;
   - `native`: the provider reads it from a place Frink leaves alone (managed policy, the
     repository, or, for Codex, the user's own config folder);
   - `hidden-by-design`: deliberately not carried over;
   - `inert-headless`: it only drives a terminal UI, which a Frink chat never shows;
   - `not-yet-delivered`: a known gap, recorded rather than fixed. It works in the terminal but
     not in Frink.

   Codex also has `disabled-by-frink` for features Frink turns off, Cursor marks the setting
   sources it loads as `loaded`, and Copilot marks options it leaves at their default as
   `default-reviewed`.

The Claude contract covers top-level settings keys only. Nested keys such as `permissions.*` are
not checked yet.

## Configuration

Build-time `MAIN_VITE_*` / `VITE_*` / `RENDERER_VITE_*` values are baked into the app bundle.
Anything left unset means that feature is off in the build.

| Name | Kind | Used by | Purpose |
|------|------|---------|---------|
| `MAIN_VITE_UPDATE_FEED_URL` | `.env` (mac) | build, release gate | Generic electron-updater feed. Must be https, with no quotes and no credentials. Unset = auto-update off. |
| `UPDATE_FEED_URL` | repo **variable** | CI build, release gate | CI value for `MAIN_VITE_UPDATE_FEED_URL`. |
| `MAIN_VITE_POSTHOG_KEY` | `.env` / repo secret | build | PostHog project key. Only the main process sends usage events ([what Frink sends](../user-docs/telemetry.md)). Unset = no analytics. |
| `MAIN_VITE_POSTHOG_HOST` | `.env` / repo variable | build | PostHog host. Unset = `https://us.i.posthog.com`. |
| `MAIN_VITE_SENTRY_DSN` / `RENDERER_VITE_SENTRY_DSN` | `.env` / repo secret | build | Sentry DSN for main / renderer. The main DSN also turns on preload crash reporting. Unset = no crash reporting. |
| `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` | `.env` / repo secrets | build | Source-map upload on release builds (`SENTRY_UPLOAD=1`). |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID` | `.env` / repo secrets | upload | R2 credentials. If all three are missing, CI tag builds skip publishing (and the feed gate). |
| `R2_BUCKET` | `.env` | upload | Bucket name. Default `frink-releases`. |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, `APPLE_IDENTITY` | `.env` | mac package | Signing and notarization (`build.mac.notarize`). |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | repo secrets | Windows package | Azure Trusted Signing. See [windows-code-signing](decisions/windows-code-signing.md). |
| `AZURE_SIGNING_ACCOUNT`, `AZURE_CERT_PROFILE`, `AZURE_SIGNING_ENDPOINT`, `AZURE_PUBLISHER_NAME` | repo variables | Windows package | Azure signing account. Windows is signed only when all seven Azure values are set. |

Official Windows and Linux releases get the same telemetry keys as the mac release.

## Usage analytics test accounts

Install and weekly-active counts for official builds are only meaningful with PostHog's
**Filter out internal and test users** switched on. The project's test-account filter excludes two cohorts:

- **Internal / Test users**: dynamic, matches persons with `$internal_or_test_user = true`. To add a
  maintainer machine, read the `.install_id` file in Frink's app data folder on that machine, find
  the person with that distinct ID in PostHog, and set `$internal_or_test_user` to `true` on it.
- **CI launch tests (Linux launch smoke, before the analytics opt-out)**: a fixed list of 66 installs.
  Until the Linux launch smoke set `FRINK_DISABLE_USAGE_ANALYTICS=1` (2026-10-19), each build-desktop
  run created a new install. The list does not grow. It holds every person between the public
  launch (2026-09-26) and that change (2026-10-19 21:14 UTC) that is Linux only and has exactly
  three events, `desktop_opened`, `first_launch` and `desktop_opened`, within 10 seconds. All 66
  were seen from 2026-10-07 to 2026-10-16, each inside a "launch the deb and the AppImage" smoke
  step. This query returns exactly the 66:

  ```sql
  SELECT person_id
  FROM events
  WHERE timestamp >= '2026-09-26' AND timestamp < '2026-10-19 21:14:27'
  GROUP BY person_id
  HAVING any(properties.platform) = 'linux' AND uniq(properties.platform) = 1
     AND count() = 3 AND countIf(event = 'desktop_opened') = 2
     AND countIf(event = 'first_launch') = 1
     AND dateDiff('second', min(timestamp), max(timestamp)) <= 10
  ```

Any new automated launch of a packaged build must set `FRINK_DISABLE_USAGE_ANALYTICS=1`, so it never
needs adding here.

## Forks

Your build is yours: it never talks to Frink's infrastructure.

- **Auto-update** is off until you host your own
  [generic feed](https://www.electron.build/auto-update) and set `MAIN_VITE_UPDATE_FEED_URL`
  (and the `UPDATE_FEED_URL` repo variable for CI). Also point `package.json` → `build.publish.url`
  at that feed, so the `latest*.yml` metadata matches.
- **Telemetry** (PostHog, Sentry) is off unless you set your own keys.
- Tag builds without R2 credentials build normally and skip publishing.
