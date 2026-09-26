export function getCustomNodesGuideline(): string {
  return `# Custom nodes: register, test, wire

A user node runs locally from \`~/.frink/nodes/<name>/\`; the desktop app must be online. Discover installed/integration steps before authoring a new one. Plugin nodes are derived from the integration catalog at read time; do not register them. The name \`integrations\` and \`<pluginId>_\` prefix are reserved. A leftover \`~/.frink/nodes/integrations/\` folder is obsolete; delete it if discovery reports it.

## Inline registration

Call \`frink_register_node\` with these arguments; no source folder is needed:

\`\`\`json
{
  "manifest": {
    "name":"count-items", "displayName":"Count Items", "description":"Return a named count",
    "version":"1.0.0", "entrypoint":"index.js", "timeout":60,
    "inputs":{"count":{"type":"number","label":"Count","required":true}},
    "outputs":{"count":{"type":"number","description":"The supplied count"}}
  },
  "scriptContent":"const config = JSON.parse(process.argv[2]); console.log(JSON.stringify({ count: config.count }));",
  "test":{"config":{"count":3},"timeoutMs":30000}
}
\`\`\`

Use the registered name as \`blockType\`, with input values under node \`config\`.
Names use lowercase letters, digits and hyphens. \`inputs\`, \`outputs\`, \`credentials\` are objects keyed by name, not arrays.

| Manifest member | Contract |
|---|---|
| inputs | Types \`string\`, \`number\`, \`boolean\`; optional \`label\`, \`description\`, \`default\`, \`required\`, \`listOptions\` |
| required input | Required only for literal \`required: true\`. Missing value without default blocks execution/test; rendered empty string is missing. Optional inputs may be empty. |
| credentials | e.g. \`{"github":{"required":true,"label":"GitHub token","helpUrl":"https://github.com/settings/tokens"}}\`; required unless explicitly \`false\` |
| outputs | Types \`string\`, \`number\`, \`boolean\`, \`object\`, \`array\`; optional description. For arrays of objects, \`items\` describes element fields (≤3 levels); omit for primitive arrays. |

Declared outputs provide editor chips and template validation. Without them, discovery falls back to \`run_command\` fields (\`exitCode\`, \`_rawStdout\`); valid stdout JSON still produces its top-level keys. Manifest, credentials and source stay local.

## JavaScript and I/O

- Use a \`.js\` ESM entrypoint, relative \`.js\`/\`.mjs\` imports, \`node:\` built-ins and global Web APIs (\`fetch\`). The app bundles Node; project/Frink dependencies and third-party packages are unavailable, and registration installs none. Use \`run_command\` for other interpreters.
- Config is **one JSON argument at \`process.argv[2]\`**, never stdin and never a \`{config, previousOutput, context}\` wrapper. It contains declared inputs plus defaults only; no \`projectId\`.
- Declared top-level input templates render then convert to their types. Number/boolean templates must be a single whole placeholder; strings may mix text. Conversion failure fails the step. Nested strings are literal.
- Print **one flat JSON object** on stdout; do not wrap it in \`{status, outputs}\`. Top-level keys become \`previous.*\`, with \`exitCode\` added. Empty/invalid/oversized stdout produces \`exitCode\` plus optional truncated \`_rawStdout\`. Send logs to stderr. Nonzero exit fails with stderr as the error.
- Await async work at module top level (\`await main()\`). Frink imports the entrypoint, waits for module evaluation, flushes output and exits; timers/sockets do not keep it alive.

For a dynamic picker, use \`listOptions: true\` on a string input (no \`select\` type). Handle \`--list-options <fieldName>\` **before** parsing config and print \`[{"name":"Display label","value":"id"}]\`. Invalid/empty output falls back to text. Options are suggestions, not an execution allowlist; validate resources/permissions in the node or API.

## Multi-file packages

For local modules or data, author an ordinary folder with \`manifest.json\`, the entrypoint, modules and resources. Pass \`packagePath\` (absolute or relative to the chat project), mutually exclusive with inline \`manifest\`/\`scriptContent\`. Frink copies the folder; the source remains yours. Omit \`package.json\`: Frink creates the installed ESM boundary and metadata.
Read data with \`readFile(new URL('./template.txt', import.meta.url), 'utf8')\`; no static image imports or absolute machine paths.

Registration replaces the entire installed node, so include all needed resources. Inline registration over a package removes its modules/resources (shown in approval preview). Limits: 256 files, 64 directories, 256 MiB total; JS ≤100 KiB/file and ≤1 MiB total. Symlinks, nonportable paths, dependency directories, native binaries and other executable scripts are rejected.
The receipt's \`source\`, \`packageDigest\`, \`packageResources\`, \`packageBytes\` (and \`packagePath\` for folders) attest captured bytes; no author-generated checksums are needed.

## Test and update

Re-register the edited inline source/package with \`test.config\` satisfying required inputs. Inspect \`testResult.exitCode\`, \`stderr\`, \`parsedOutput\`; if parsedOutput is null on exit 0, inspect \`warning\` and \`stdout\` (parsed outputs >8 KB are omitted). Only a passing captured candidate installs atomically; validation/test/stale-state failures preserve the installed node. Then wire it via \`frink_flows_patch\`. Limit: 20 registration/test calls per session.

Tests use real credentials and make real external calls. Nodes run **unsandboxed** with filesystem/process/network access. An argv boundary and scoped environment (safe host variables plus declared credentials) reduce accidental injection/leakage, but are not a sandbox. The user approves registration once; schedules/webhooks subsequently run unattended, so describe effects clearly on the registration card.
`;
}
