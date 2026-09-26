import { describe, expect, it } from 'vitest';
import { sanitizeDiagnosticContext } from './diagnostic-context';

describe('sanitizeDiagnosticContext', () => {
  it('strictly allowlists scalar Frink runtime diagnostics', () => {
    expect(
      sanitizeDiagnosticContext({
        schema_version: 1,
        main_heap_used_mb: 320.5,
        codex_app_server_count: 3,
        codex_live_turn_count: 2,
        system_pressure: true,
        provider_descendant_memory_measured: false,
        projectPath: '/Users/private/project',
        command: 'npx secret-server',
        environment: { TOKEN: 'secret' },
        nested: { prompt: 'private' },
      }),
    ).toEqual({
      schema_version: 1,
      main_heap_used_mb: 320.5,
      codex_app_server_count: 3,
      codex_live_turn_count: 2,
      system_pressure: true,
      provider_descendant_memory_measured: false,
    });
  });

  it('rejects invalid or fully disallowed contexts', () => {
    expect(sanitizeDiagnosticContext('not-an-object')).toBeNull();
    expect(
      sanitizeDiagnosticContext({
        projectPath: '/private/project',
        nested: { prompt: 'secret' },
      }),
    ).toBeNull();
  });
});
