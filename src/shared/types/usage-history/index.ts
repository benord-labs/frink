/** Heatmap buckets: 0 = no usage, 1–4 = quartiles of the active days. */
export type UsageLevel = 0 | 1 | 2 | 3 | 4;

export type UsageHistoryDay = {
  /** Local calendar day, `YYYY-MM-DD`; empty for a cell after today. */
  date: string;
  claude: number;
  codex: number;
  /** Conversations with usage that day, per provider. */
  chats: { claude: number; codex: number };
  level: { all: UsageLevel; claude: UsageLevel; codex: UsageLevel };
};

/** How the user has used Frink here, from its own chats' transcripts. Tokens are new input plus
 * output, never re-sent earlier messages, so they never match plan limits. */
export type UsageHistory = {
  /** First local day with usage, or null before any. */
  since: string | null;
  totalTokens: number;
  /** 53 weeks, oldest first, each Sunday → Saturday, ending with the current week. */
  weeks: UsageHistoryDay[][];
  busiestDay: { date: string; tokens: number } | null;
  currentStreak: number;
  longestStreak: number;
  /** Local hour (0–23) with the most tokens. */
  busiestHour: number | null;
  topModel: { model: string; share: number } | null;
  conversations: number;
  /** Skills and MCP servers, by the number of conversations that used them. */
  integrations: Array<{ kind: 'skill' | 'mcp'; name: string; conversations: number }>;
  providers: { claude: boolean; codex: boolean };
  updatedAt: number;
};

/** Flows and tasks from Frink's own database, for the Usage page's activity insights. */
export type UsageActivity = {
  flowRuns: number;
  /** Tasks ready for review or accepted. */
  tasksFinished: number;
  topFlows: Array<{ name: string; runs: number }>;
};
