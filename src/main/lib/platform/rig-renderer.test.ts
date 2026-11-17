import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertRigRendererBundled } from './rig-renderer';

describe('assertRigRendererBundled', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses to boot the rig bundle when it was handed the host's dev-server URL", () => {
    vi.stubEnv('FRINK_QA_BUNDLE', '1');
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173');
    expect(() => assertRigRendererBundled()).toThrow(
      /Refusing to boot: .*ELECTRON_RENDERER_URL=http:\/\/localhost:5173/,
    );
  });

  it('boots the rig bundle when no dev-server URL leaked in', () => {
    vi.stubEnv('FRINK_QA_BUNDLE', '1');
    vi.stubEnv('ELECTRON_RENDERER_URL', undefined);
    expect(() => assertRigRendererBundled()).not.toThrow();
  });

  it('leaves an isolated electron-vite dev instance (CDP port, no rig marker) alone', () => {
    vi.stubEnv('FRINK_QA_BUNDLE', undefined);
    vi.stubEnv('FRINK_CDP_PORT', '9224');
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173');
    expect(() => assertRigRendererBundled()).not.toThrow();
  });
});
