// @vitest-environment happy-dom
import * as monaco from 'monaco-editor';
import { expect, it } from 'vitest';

it('switches the editor to the Shiki tokenizers when it is configured', async () => {
  expect(monaco.json.jsonDefaults.modeConfiguration.tokens).toBe(true);

  await import('./monaco-loader-config');

  // Registration hands JSON to Shiki, so the JSON mode's own tokenizer is turned off.
  expect(monaco.json.jsonDefaults.modeConfiguration.tokens).toBe(false);
});
