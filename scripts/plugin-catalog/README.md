# Bundled plugin inventory

Plugin pages use the shared catalogue for descriptions, triggers, curated actions,
MCP declarations and runtime support. Vendor skill and slash-command inventories
are generated into `src/shared/integrations/vendor-inventory/*.json`. Browsing
does not download or inspect an installed plugin. Accounts, grants, webhook state
and actual runtime tool discovery remain live.

When changing `VENDOR_PLUGIN_PINS`, regenerate the inventories:

```sh
bun scripts/plugin-catalog/generate.ts --acquire
bunx oxfmt --write src/shared/integrations/vendor-inventory
bun scripts/plugin-catalog/generate.ts --check
```

`--acquire` fetches the exact source commits into a development-only bare Git
cache under `~/.cache/frink-plugin-catalog`. Without it, generation and `--check`
use cached commits offline. Git archives extract the pinned package directories
into temporary folders; no plugin is installed or enabled. Normal builds use the
committed JSON and require neither the cache nor network access.

Generation reuses the runtime skill/command scanner, verifies readable payloads
and explicit skill roots, and validates all inputs before replacing any output.
Paths in JSON are package-relative display metadata, never runtime paths.
The shared catalogue test compares every generated pin coordinate (including the
repository and monorepo package directory) with the installation pins, so changing
a pin requires regenerating metadata even if the source SHA stays the same.
