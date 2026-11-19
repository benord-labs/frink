import { fileURLToPath } from 'node:url';
import { getConfig } from 'expo/config';
import { expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

it('builds the app with the React Compiler on', () => {
  const { exp } = getConfig(projectRoot, { skipSDKVersionRequirement: true });
  expect(exp.experiments?.reactCompiler).toBe(true);
});
