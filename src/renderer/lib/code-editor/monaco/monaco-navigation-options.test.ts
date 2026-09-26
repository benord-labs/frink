import { describe, expect, it } from 'vitest';
import { getMonacoNavigationOptions } from './monaco-navigation-options';

describe('monaco navigation options', () => {
  it('disables peek when opening definition links', () => {
    expect(getMonacoNavigationOptions().definitionLinkOpensInPeek).toBe(false);
  });

  it('navigates directly for multi-result go-to actions', () => {
    expect(getMonacoNavigationOptions().gotoLocation).toEqual({
      multipleDefinitions: 'goto',
      multipleTypeDefinitions: 'goto',
      multipleDeclarations: 'goto',
      multipleImplementations: 'goto',
      multipleReferences: 'goto',
    });
  });
});
