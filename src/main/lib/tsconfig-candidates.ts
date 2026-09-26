/**
 * Config file names tried in order when resolving TypeScript/JavaScript project config.
 * Shared by module-resolver and tsconfig-resolver so candidate order stays in sync.
 */
export const CONFIG_CANDIDATES = ['tsconfig.json', 'tsconfig.app.json', 'jsconfig.json'] as const;
