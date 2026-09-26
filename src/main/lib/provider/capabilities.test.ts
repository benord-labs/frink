import { describe, expect, it } from 'vitest';
import { builtinRuntimeSupport } from '../../../shared/integrations/plugin-runtime-support';
import { CAPABILITY_MAP } from './capabilities';

describe('CAPABILITY_MAP ↔ PluginRuntime', () => {
  it('lists a plugin runtime exactly when its descriptor delivers plugins', () => {
    // Flipping a descriptor's `plugins` off `none` (Cursor, one day) must add its row to the page.
    const delivering = Object.entries(CAPABILITY_MAP)
      .filter(([, descriptor]) => descriptor.plugins !== 'none')
      .map(([provider]) => provider)
      .sort();
    const listed = Object.keys(
      builtinRuntimeSupport({
        mcpServers: [],
        skills: [],
        nativeExtensions: [],
        triggers: [],
        actions: [],
      }),
    ).sort();
    expect(listed).toEqual(delivering);
  });
});
