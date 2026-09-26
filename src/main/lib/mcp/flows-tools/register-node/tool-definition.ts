export const REGISTER_NODE_TOOL = {
  name: 'frink_register_node',
  description:
    'Register or update a global custom flow node at ~/.frink/nodes/<name>. Default: pass manifest + scriptContent inline for a single-file node — one call, no files on disk. Pass packagePath instead (never both) only when the node imports local .js/.mjs modules or bundles data files. Frink previews the full package and asks for permission before testing or atomically installing it.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      manifest: {
        type: 'object',
        description:
          'Node identity and I/O contract for inline registration. Required with scriptContent.',
        properties: {
          name: {
            type: 'string',
            description:
              'Node name matching /^[a-z0-9][a-z0-9_-]*$/; the node installs at ~/.frink/nodes/<name>.',
          },
          displayName: { type: 'string', description: 'Human-readable name shown in the editor.' },
          description: { type: 'string', description: 'What the node does.' },
          version: { type: 'string' },
          entrypoint: {
            type: 'string',
            description: 'Plain .js filename with no path separators, e.g. "index.js".',
          },
          timeout: {
            type: 'number',
            description: 'Execution timeout in seconds (max 600).',
          },
          inputs: {
            type: 'object',
            description:
              'Config fields, e.g. { "repo": { "type": "string", "label": "Repository", "required": true } }.',
          },
          credentials: {
            type: 'object',
            description:
              'Named credentials the script reads from env, e.g. { "github": { "required": true, "label": "GitHub token" } }.',
          },
          outputs: {
            type: 'object',
            description:
              'Output fields the script prints as flat JSON on stdout; top-level keys become step outputs.',
          },
        },
        required: ['name', 'entrypoint'],
      },
      scriptContent: {
        type: 'string',
        description:
          'ESM JavaScript source for the entrypoint. Use with manifest for a single-file node — no files on disk needed. Node built-ins and global Web APIs only; max 100 KiB.',
      },
      packagePath: {
        type: 'string',
        description:
          "Folder package path — absolute, or relative to the chat's project directory. Only needed when the node imports local .js/.mjs modules or bundles data files. The folder contains manifest.json, one declared .js entrypoint, optional local .js/.mjs modules, and data files (max 256 files, 64 directories, 256 MiB total; JavaScript is capped at 100 KiB per file and 1 MiB total). No symlinks, package.json, node_modules, .git, native binaries, or other scripts. Updates replace the full package.",
      },
      test: {
        type: 'object',
        description:
          'Optional. After consent, runs the captured package in a disposable clone before installation and returns stdout/stderr/parsedOutput. parsedOutput is null when the serialized output exceeds 8KB — check testResult.warning and inspect testResult.stdout directly in that case. Useful for iterative debugging without starting a full flow. Tests use real credentials. Rate shared with registration: 20 per session total.',
        properties: {
          config: {
            type: 'object',
            description:
              'Config object passed as one JSON string in process.argv[2]. Uses the same format as flow node config.',
          },
          timeoutMs: {
            type: 'number',
            description:
              'Script timeout in ms. Default: 10000 (10s). Must be an integer from 1000 through 120000.',
          },
        },
      },
    },
    required: [],
    additionalProperties: false,
  },
} as const;
