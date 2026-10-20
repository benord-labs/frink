import type { Settings } from '@anthropic-ai/claude-agent-sdk';
import contract from './claude-settings-routes.json';

/** The literal keys of a type, without the `[k: string]: unknown` the SDK's Settings carries. */
export type KnownKeys<T> = keyof {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K];
};

/** Fails typecheck, naming each member, unless `T` is empty. */
export type AssertNone<T extends never> = T;

/** What happens to a key set in ~/.claude/settings.json, which a chat's own config dir hides;
 * docs/RELEASING.md defines each route. Project and local settings files load natively. */
export type ClaudeSettingRoute =
  | 'delivered'
  | 'frink-owned'
  | 'native'
  | 'hidden-by-design'
  | 'inert-headless'
  | 'not-yet-delivered';

type Routed = keyof typeof contract.routes;
// A key the SDK adds, then a key it drops, fails typecheck here by name.
type _Unrouted = AssertNone<Exclude<KnownKeys<Settings>, Routed>>;
type _Dropped = AssertNone<Exclude<Routed, KnownKeys<Settings>>>;

export const CLAUDE_SETTINGS_CONTRACT = contract;
