import { describe, expect, it } from 'vitest';
import { integrationLabel, modelLabel } from './labels';

describe('integrationLabel', () => {
  it("reads a plugin's namespaced server as the plugin, the same as the vendor's own server", () => {
    expect(integrationLabel('plugin_shortcut_shortcut')).toBe(integrationLabel('shortcut'));
    expect(integrationLabel('shortcut')).toBe('Shortcut');
  });

  it('makes an unknown server readable', () => {
    expect(integrationLabel('autonomous_bugs')).toBe('Autonomous bugs');
    expect(integrationLabel('plugin_acme_tools')).toBe('Acme');
    expect(integrationLabel('plugin_slack_slack')).toBe('Slack');
  });
});

describe('modelLabel', () => {
  it('reads an unlisted Claude API id as family and version', () => {
    expect(modelLabel('claude-sonnet-4-6')).toBe('Sonnet 4.6');
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(modelLabel('claude-mystery-9')).toBe('Mystery 9');
    expect(modelLabel('<synthetic>')).toBe('<synthetic>');
  });
});
