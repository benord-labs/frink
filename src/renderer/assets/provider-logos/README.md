# Provider logo provenance

Provider marks are vendor identity, not Frink artwork. Keep downloaded SVGs unmodified and replace
them only from the listed vendor source. Slack, Gmail, and GitHub are bundled as offline Iconify
data from `@iconify-icons/logos`; their rendered paths and fills were checked against the vendor
resources below.

## Why these SVGs are local

Icon packages lag vendor rebrands. On 2026-09-24 `@iconify-icons/logos/shortcut-icon` still shipped
Shortcut's retired light-blue (`#58B1E4`) mark, while shortcut.com serves the current purple
(`#494BCB`) one byte-for-byte as `shortcut.svg` below. So a mark fetched from the vendor's own site
stays a local file; do not swap it for a package copy without diffing the two against the vendor
source first.

| Provider | Source | Bundled form | Retrieved / checked |
| --- | --- | --- | --- |
| ClickUp | https://clickup.com/assets/brand/v4/Logomark-gradient.svg | `clickup.svg` | 2026-08-23 |
| Shortcut | https://www.shortcut.com/assets/branding/mark-default.svg | `shortcut.svg` | 2026-08-23 |
| Slack | https://slack.com/media-kit | `@iconify-icons/logos/slack-icon` | 2026-08-23 |
| Gmail | https://about.google/brand-resource-center/products-and-services/ | `@iconify-icons/logos/google-gmail` | 2026-08-23 |
| GitHub | https://brand.github.com/foundations/logo | `@iconify-icons/logos/github-icon` | 2026-08-23 |
| Amplemarket | https://app.amplemarket.com/logo.svg | `amplemarket.svg` | 2026-09-04 |
| Docusign | https://developers.docusign.com/favicon.svg | `docusign.svg` | 2026-09-04 |
| Gong | https://gong.io/marketing-assets/favicon.svg | `gong.svg` | 2026-09-04 |
| Profound | https://tryprofound.com/favicons/favicon-light.svg | `profound.svg` | 2026-09-04 |
| Hugging Face | https://huggingface.co/brand | `@iconify-icons/logos/hugging-face-icon` | 2026-09-04 |
| X | https://about.x.com/en/who-we-are/brand-toolkit | `@iconify-icons/logos/x` | 2026-09-04 |

Catalog plugin marks (Asana, Atlassian, Cloudflare, Figma, Google Calendar, Google Drive, HubSpot,
Intercom, Neon, Notion, PayPal, Playwright, PostHog, Salesforce, Sentry, Square, Supabase, Vercel,
Webflow, Zoom) are bundled unmodified from `@iconify-icons/logos` (the gilbarbara/logos set, which
carries each vendor's own SVG) and were added on 2026-09-02.

## When no mark exists

Ashby, Canva, Circleback, Clay, Context7, Juicebox, Navan and Outreach publish no square mark in any
licensed corpus and none on their own sites: what they ship is a wordmark, or a raster app icon only.
Cropping a wordmark to its symbol would modify vendor artwork, so those rows carry **initials**
instead — two letters in Frink's own type on the standard plate (`NO_MARK` in
`components/ProviderIcon`). Two, not one, because Canva, Circleback, Clay and Context7 would
otherwise share an identical "C" and the tile would stop telling the rows apart. Initials are a
placeholder, never a claim to be the vendor's mark: replace one the moment that vendor publishes a
square SVG, and add its row to the table above.

`generic_webhook` is not a vendor and keeps the Lucide glyph.

All names and logos remain trademarks of their respective owners and identify supported
integrations only. Do not recolor, redraw, or use them as Frink branding.
