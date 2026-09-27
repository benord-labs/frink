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

## Configuration

Build-time `MAIN_VITE_*` / `VITE_*` / `RENDERER_VITE_*` values are baked into the app bundle.
Anything left unset means that feature is off in the build.

| Name | Kind | Used by | Purpose |
|------|------|---------|---------|
| `MAIN_VITE_UPDATE_FEED_URL` | `.env` (mac) | build, release gate | Generic electron-updater feed. Must be https, with no quotes and no credentials. Unset = auto-update off. |
| `UPDATE_FEED_URL` | repo **variable** | CI build, release gate | CI value for `MAIN_VITE_UPDATE_FEED_URL`. |
| `MAIN_VITE_POSTHOG_KEY` / `VITE_POSTHOG_KEY` | `.env` / repo secret | build | PostHog project key for main / renderer. Unset = no analytics. |
| `MAIN_VITE_POSTHOG_HOST` / `VITE_POSTHOG_HOST` | `.env` / repo variable | build | PostHog host. Unset = `https://us.i.posthog.com`. |
| `MAIN_VITE_SENTRY_DSN` / `RENDERER_VITE_SENTRY_DSN` | `.env` / repo secret | build | Sentry DSN for main / renderer. Unset = no crash reporting. |
| `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` | `.env` / repo secrets | build | Source-map upload on release builds (`SENTRY_UPLOAD=1`). |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID` | `.env` / repo secrets | upload | R2 credentials. If all three are missing, CI tag builds skip publishing (and the feed gate). |
| `R2_BUCKET` | `.env` | upload | Bucket name. Default `frink-releases`. |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, `APPLE_IDENTITY` | `.env` | mac package | Signing and notarization (`build.mac.notarize`). |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | repo secrets | Windows package | Azure Trusted Signing. See [windows-code-signing](decisions/windows-code-signing.md). |
| `AZURE_SIGNING_ACCOUNT`, `AZURE_CERT_PROFILE`, `AZURE_SIGNING_ENDPOINT`, `AZURE_PUBLISHER_NAME` | repo variables | Windows package | Azure signing account. Windows is signed only when all seven Azure values are set. |

Official Windows and Linux releases get the same telemetry keys as the mac release.

## Forks

Your build is yours: it never talks to Frink's infrastructure.

- **Auto-update** is off until you host your own
  [generic feed](https://www.electron.build/auto-update) and set `MAIN_VITE_UPDATE_FEED_URL`
  (and the `UPDATE_FEED_URL` repo variable for CI). Also point `package.json` → `build.publish.url`
  at that feed, so the `latest*.yml` metadata matches.
- **Telemetry** (PostHog, Sentry) is off unless you set your own keys.
- Tag builds without R2 credentials build normally and skip publishing.
