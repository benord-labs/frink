export const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === null || proto === Object.prototype;
};

export const isTransformable = (v: unknown): boolean => Array.isArray(v) || isPlainObject(v);
