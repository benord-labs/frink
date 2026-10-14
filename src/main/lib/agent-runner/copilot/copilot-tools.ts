/** How Frink's gate reads one GitHub Copilot tool; a tool without a question runs quietly. */
export type CopilotToolRule = {
  question?: 'Bash' | 'Edit' | 'Read' | 'WebFetch' | 'WebSearch';
  /** Every input key the tool may send; a call with any other key is refused. */
  keys: readonly string[];
  /** The only values some keys may take. */
  values?: Readonly<Record<string, readonly (string | boolean)[]>>;
  /** Keys a call must send, where leaving one out lets the tool pick a default Frink can't see. */
  required?: readonly string[];
  /** An input key holding a path glob, judged from the folder it starts in. */
  glob?: string;
};

export type CopilotTools = Readonly<Record<string, CopilotToolRule>>;

const SEARCH_KEYS = [
  'pattern',
  'paths',
  'output_mode',
  'glob',
  'type',
  'head_limit',
  'multiline',
  '-i',
  '-A',
  '-B',
  '-C',
  '-n',
];

/** The only tools a Copilot session may offer: every one Frink's gate knows how to ask about. */
export const COPILOT_TOOLS = {
  // No shellId: reusing a shell would carry state between calls the gate judged apart. No detach:
  // a detached process outlives the turn and the session, which the command card cannot show.
  bash: {
    question: 'Bash',
    keys: ['command', 'description', 'mode', 'detach', 'initial_wait'],
    values: { detach: [false] },
  },
  create: { question: 'Edit', keys: ['path', 'file_text'] },
  edit: { question: 'Edit', keys: ['path', 'old_str', 'new_str'] },
  apply_patch: { question: 'Edit', keys: [] },
  view: { question: 'Read', keys: ['path', 'view_range', 'forceReadLargeFiles'] },
  grep: { question: 'Read', keys: SEARCH_KEYS },
  rg: { question: 'Read', keys: SEARCH_KEYS },
  glob: { question: 'Read', keys: ['pattern', 'paths'], glob: 'pattern' },
  web_fetch: { question: 'WebFetch', keys: ['url', 'max_length', 'start_index', 'raw'] },
  web_search: { question: 'WebSearch', keys: ['query'] },
  sql: { keys: ['description', 'query', 'database'] },
  read_bash: { keys: ['shellId', 'delay'] },
  stop_bash: { keys: ['shellId'] },
  list_bash: { keys: [] },
  read_agent: { keys: ['agent_id', 'since_turn', 'timeout', 'wait'] },
  list_agents: { keys: ['include_completed', 'scope'] },
  write_agent: { keys: ['agent_id', 'agent_ids', 'message', 'scope'] },
  task: {
    keys: [
      'description',
      'prompt',
      'agent_type',
      'name',
      'model',
      'reasoning_effort',
      'context_tier',
      'mode',
    ],
    values: {
      agent_type: [
        'explore',
        'task',
        'general-purpose',
        'code-review',
        'research',
        'security-review',
      ],
      mode: ['sync'],
    },
    required: ['mode'],
  },
  task_complete: { keys: ['summary'] },
} satisfies CopilotTools;
