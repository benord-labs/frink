const NUMBER_KEYS = new Set([
  'schema_version',
  'sampled_at_ms',
  'sample_sequence',
  'main_heap_used_mb',
  'main_heap_total_mb',
  'main_heap_limit_mb',
  'main_heap_used_pct',
  'main_rss_mb',
  'main_external_mb',
  'main_array_buffers_mb',
  'system_total_mb',
  'system_free_mb',
  'system_free_pct',
  'system_available_mb',
  'system_available_pct',
  'system_file_backed_mb',
  'system_purgeable_mb',
  'electron_process_count',
  'electron_working_set_sum_mb',
  'browser_count',
  'browser_working_set_sum_mb',
  'renderer_count',
  'renderer_working_set_sum_mb',
  'renderer_max_working_set_mb',
  'renderer_footprint_sum_mb',
  'renderer_max_footprint_mb',
  'peak_renderer_footprint_mb',
  'renderer_swapped_sum_mb',
  'gpu_count',
  'gpu_working_set_sum_mb',
  'utility_count',
  'utility_working_set_sum_mb',
  'other_process_count',
  'other_working_set_sum_mb',
  'peak_main_heap_used_mb',
  'peak_main_rss_mb',
  'peak_renderer_working_set_mb',
  'peak_electron_working_set_sum_mb',
  'active_execution_count',
  'ownerless_execution_count',
  'checkpoint_persist_count',
  'checkpoint_persist_ms_total',
  'checkpoint_persist_ms_max',
  'checkpoint_persist_parts_max',
  'stream_chunk_gap_ms_max',
  'claude_session_count',
  'claude_busy_session_count',
  'claude_retained_session_count',
  'claude_query_starts_total',
  'claude_query_starts_60s',
  'codex_app_server_count',
  'codex_live_turn_count',
  'codex_turn_starts_total',
  'codex_turn_starts_60s',
  'configured_mcp_total',
  'configured_mcp_stdio',
  'configured_mcp_http',
]);

const BOOLEAN_KEYS = new Set([
  'main_pressure',
  'renderer_pressure',
  'system_pressure',
  'renderer_footprint_measured',
  'system_pressure_measured',
  'system_pressure_sustained',
  'provider_descendant_memory_measured',
]);

export type DiagnosticContext = Partial<Record<string, number | boolean>>;

/**
 * Sentry's crash scope is cached to disk for the native minidump integration.
 * Keep that cache incapable of accepting identity, paths, prompts, commands,
 * URLs, environment values, or nested content even if a future caller passes it.
 */
export function sanitizeDiagnosticContext(value: unknown): DiagnosticContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const safe: DiagnosticContext = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (NUMBER_KEYS.has(key) && typeof candidate === 'number' && Number.isFinite(candidate)) {
      safe[key] = candidate;
    } else if (BOOLEAN_KEYS.has(key) && typeof candidate === 'boolean') {
      safe[key] = candidate;
    }
  }
  return Object.keys(safe).length > 0 ? safe : null;
}
