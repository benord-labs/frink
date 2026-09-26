import { describe, expect, it } from 'vitest';
import { applyDebugModePrefix, buildDebugModePrompt, type DebugModePromptOpts } from './debug-mode';

const DEFAULT_OPTS: DebugModePromptOpts = {
  sessionId: 'abc123',
  logFilePath: '/tmp/project/.frink/debug/abc123.ndjson',
  ingestEndpoint: 'http://127.0.0.1:9999/ingest/abc123',
};

describe('debug-mode', () => {
  describe('buildDebugModePrompt', () => {
    it('replaces all {{SESSION_ID}} placeholders', () => {
      const result = buildDebugModePrompt(DEFAULT_OPTS);

      // Should contain the session ID in multiple places
      expect(result).toContain("'abc123'");
      expect(result).toContain('Session ID**: abc123');
      // Should not contain any unreplaced placeholders
      expect(result).not.toContain('{{SESSION_ID}}');
    });

    it('replaces all {{LOG_FILE_PATH}} placeholders', () => {
      const result = buildDebugModePrompt(DEFAULT_OPTS);

      expect(result).toContain('/tmp/project/.frink/debug/abc123.ndjson');
      expect(result).not.toContain('{{LOG_FILE_PATH}}');
    });

    it('replaces all {{INGEST_ENDPOINT}} placeholders', () => {
      const result = buildDebugModePrompt(DEFAULT_OPTS);

      expect(result).toContain('http://127.0.0.1:9999/ingest/abc123');
      expect(result).not.toContain('{{INGEST_ENDPOINT}}');
    });

    it('contains the hypothesis-driven workflow steps', () => {
      const result = buildDebugModePrompt(DEFAULT_OPTS);

      expect(result).toContain('DEBUG MODE');
      expect(result).toContain('3-5 precise hypotheses');
      expect(result).toContain('NDJSON');
      expect(result).toContain('// #region debug log');
    });

    it('contains the one-liner fetch template with correct endpoint', () => {
      const result = buildDebugModePrompt(DEFAULT_OPTS);

      expect(result).toContain("fetch('http://127.0.0.1:9999/ingest/abc123',{method:'POST'");
    });

    it('handles special characters in paths without breaking', () => {
      const opts: DebugModePromptOpts = {
        sessionId: 'session-with-dashes-123',
        logFilePath: '/home/user/my project/.frink/debug/session-with-dashes-123.ndjson',
        ingestEndpoint: 'http://127.0.0.1:45678/ingest/session-with-dashes-123',
      };

      const result = buildDebugModePrompt(opts);

      expect(result).toContain('session-with-dashes-123');
      expect(result).toContain('my project/.frink/debug');
      expect(result).not.toContain('{{SESSION_ID}}');
      expect(result).not.toContain('{{LOG_FILE_PATH}}');
      expect(result).not.toContain('{{INGEST_ENDPOINT}}');
    });
  });

  describe('applyDebugModePrefix', () => {
    it('prepends debug prompt when mode is "debug"', () => {
      const userPrompt = 'Fix the login bug';
      const result = applyDebugModePrefix(userPrompt, 'debug', DEFAULT_OPTS);

      expect(result).toContain('DEBUG MODE');
      expect(result).toContain('Fix the login bug');
      // Debug prompt comes before user prompt
      const debugIdx = result.indexOf('DEBUG MODE');
      const userIdx = result.indexOf('Fix the login bug');
      expect(debugIdx).toBeLessThan(userIdx);
    });

    it('returns prompt unchanged when mode is "agent"', () => {
      const userPrompt = 'Fix the login bug';
      const result = applyDebugModePrefix(userPrompt, 'agent', DEFAULT_OPTS);
      expect(result).toBe(userPrompt);
    });

    it('returns prompt unchanged when mode is "plan"', () => {
      const userPrompt = 'Plan the refactor';
      const result = applyDebugModePrefix(userPrompt, 'plan', DEFAULT_OPTS);
      expect(result).toBe(userPrompt);
    });
  });
});
