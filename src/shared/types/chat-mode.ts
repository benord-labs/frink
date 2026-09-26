/**
 * Chat execution mode — determines agent behavior and system prompt.
 *
 * - `agent`: Default mode, full tool access
 * - `plan`: Read-only planning mode, restricted tools
 * - `debug`: Hypothesis-driven debugging with instrumentation and NDJSON logging
 */
export type ChatMode = 'agent' | 'plan' | 'debug';
