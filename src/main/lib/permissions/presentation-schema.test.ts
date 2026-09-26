import { describe, expect, it } from 'vitest';
import type { PermissionPresentation } from '../../../shared/types/permissions';
import { isValidPermissionPresentation } from './presentation-schema';

const TOOL = 'mcp__frink_dynamic_chat__frink_register_node';
type CyclicFixture = { self?: object };
const presentation: PermissionPresentation = {
  type: 'custom-node-registration',
  packagePath: 'examples/custom-nodes/read-colocated-image',
  action: 'create',
  node: { name: 'read-colocated-image', entrypoint: 'index.js' },
  source: { current: "console.log('ok');" },
  modules: [],
  resources: [{ path: 'cinder.png', bytes: 5795, change: 'added' }],
  credentialNames: [],
  packageDigest: 'a'.repeat(64),
  packageBytes: 6000,
  warning: 'Runs unsandboxed.',
};

describe('isValidPermissionPresentation', () => {
  it('accepts the canonical tool presentation', () => {
    expect(isValidPermissionPresentation(TOOL, presentation)).toBe(true);
  });

  it('rejects malformed resource changes', () => {
    expect(
      isValidPermissionPresentation(TOOL, {
        ...presentation,
        // SAFETY: Deliberately malformed runtime payload verifies schema rejection.
        resources: [{ path: 'cinder.png', bytes: 5795, change: 1 }] as never,
      }),
    ).toBe(false);
  });

  it('rejects cyclic test config without throwing', () => {
    const cyclic: CyclicFixture = {};
    cyclic.self = cyclic;
    expect(
      isValidPermissionPresentation(TOOL, {
        ...presentation,
        // SAFETY: Deliberately cyclic runtime payload verifies fail-closed parsing.
        test: { config: cyclic, timeoutMs: 10_000 } as never,
      }),
    ).toBe(false);
  });
});
