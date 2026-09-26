import {
  getNodeCreatorCategories,
  type NodeCreatorCategory,
} from '../../../../../shared/lib/block-registry';

export type { NodeCreatorCategory };

export const NODE_CREATOR_CATEGORIES: NodeCreatorCategory[] = getNodeCreatorCategories()
  .map((c) => ({ id: c.id, label: c.label, types: c.types }))
  .filter((c) => c.types.length > 0);
