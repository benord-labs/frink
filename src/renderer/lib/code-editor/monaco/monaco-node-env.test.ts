import { describe, expect, it, vi } from 'vitest';
import { limitTsDiagnosticsToSyntax } from './monaco-node-env';

function fakeDefaults() {
  return {
    addExtraLib: vi.fn(),
    setCompilerOptions: vi.fn(),
    setDiagnosticsOptions: vi.fn(),
    setEagerModelSync: vi.fn(),
  };
}

describe('limitTsDiagnosticsToSyntax', () => {
  it('reports syntax errors but not semantic ones for TS and JS', () => {
    const monaco = {
      typescript: { typescriptDefaults: fakeDefaults(), javascriptDefaults: fakeDefaults() },
    };

    limitTsDiagnosticsToSyntax(monaco);

    for (const defaults of [
      monaco.typescript.typescriptDefaults,
      monaco.typescript.javascriptDefaults,
    ]) {
      expect(defaults.setDiagnosticsOptions).toHaveBeenCalledWith(
        expect.objectContaining({ noSyntaxValidation: false, noSemanticValidation: true }),
      );
      expect(defaults.setEagerModelSync).toHaveBeenCalledWith(true);
    }
  });
});
