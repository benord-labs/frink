const CAMEL_KEY_REGEX = /[_-]+([a-z0-9])/gi;

export const toCamelKey = (key: string): string => {
  // Fast path: keys without `_` or `-` are already camelCase. Avoids regex alloc
  // on hot tRPC response paths where most keys are already camel post-mapRow.
  if (key.indexOf('_') === -1 && key.indexOf('-') === -1) return key;
  return key.replace(CAMEL_KEY_REGEX, (_, c: string) => c.toUpperCase());
};
