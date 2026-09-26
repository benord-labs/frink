type GoToLocationBehavior = 'peek' | 'gotoAndPeek' | 'goto';

type MonacoGotoLocationOptions = {
  multipleDefinitions: GoToLocationBehavior;
  multipleTypeDefinitions: GoToLocationBehavior;
  multipleDeclarations: GoToLocationBehavior;
  multipleImplementations: GoToLocationBehavior;
  multipleReferences: GoToLocationBehavior;
};

type MonacoNavigationOptions = {
  definitionLinkOpensInPeek: boolean;
  gotoLocation: MonacoGotoLocationOptions;
};

const DIRECT_NAVIGATION_BEHAVIOR: GoToLocationBehavior = 'goto';

export function getMonacoNavigationOptions(): MonacoNavigationOptions {
  return {
    definitionLinkOpensInPeek: false,
    gotoLocation: {
      multipleDefinitions: DIRECT_NAVIGATION_BEHAVIOR,
      multipleTypeDefinitions: DIRECT_NAVIGATION_BEHAVIOR,
      multipleDeclarations: DIRECT_NAVIGATION_BEHAVIOR,
      multipleImplementations: DIRECT_NAVIGATION_BEHAVIOR,
      multipleReferences: DIRECT_NAVIGATION_BEHAVIOR,
    },
  };
}
