const GLOBAL_OCCLUDING_LAYER_SELECTOR = [
  '[data-artifact-preview-occluder]',
  '[class~="fixed"][class~="inset-0"]:not([class~="pointer-events-none"])',
  '[class~="z-99999"]',
  'dialog[open]',
  '[role="dialog"][aria-modal="true"]',
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][aria-modal="true"]',
  '[role="alertdialog"][data-state="open"]',
].join(',');
const INTERSECTING_LAYER_SELECTOR = [
  '[role="menu"][data-state="open"]',
  '[role="listbox"][data-state="open"]',
  '[role="tooltip"][data-state="open"]',
  '[role="tooltip"][data-state="delayed-open"]',
  '[data-radix-popper-content-wrapper] [data-state="open"]',
].join(',');
const OCCLUDING_LAYER_SELECTOR = `${GLOBAL_OCCLUDING_LAYER_SELECTOR},${INTERSECTING_LAYER_SELECTOR}`;

export type OccludingLayers = {
  all: HTMLElement[];
  global: HTMLElement[];
  intersecting: HTMLElement[];
};

function rectanglesIntersect(first: DOMRect, second: DOMRect): boolean {
  return (
    first.width > 0 &&
    first.height > 0 &&
    second.width > 0 &&
    second.height > 0 &&
    first.left < second.right &&
    first.right > second.left &&
    first.top < second.bottom &&
    first.bottom > second.top
  );
}

function isLayerVisible(layer: HTMLElement): boolean {
  for (let current: HTMLElement | null = layer; current; current = current.parentElement) {
    if (
      current.hidden ||
      current.getAttribute('aria-hidden') === 'true' ||
      current.dataset.state === 'closed'
    ) {
      return false;
    }
    const style = getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
}

export function scanOccludingLayers(): OccludingLayers {
  const global = [...document.querySelectorAll<HTMLElement>(GLOBAL_OCCLUDING_LAYER_SELECTOR)];
  const intersecting = [...document.querySelectorAll<HTMLElement>(INTERSECTING_LAYER_SELECTOR)];
  return {
    all: [...global, ...intersecting],
    global: global.filter(isLayerVisible),
    intersecting: intersecting.filter(isLayerVisible),
  };
}

export function isCoveredByLayers(target: HTMLElement | null, layers: OccludingLayers): boolean {
  if (!target) return false;
  if (layers.global.length > 0) return true;
  const targetBounds = target.getBoundingClientRect();
  return layers.intersecting.some((layer) =>
    rectanglesIntersect(layer.getBoundingClientRect(), targetBounds),
  );
}

export function mutationTouchesOccluder(record: MutationRecord, layers: OccludingLayers): boolean {
  if (record.type === 'attributes') {
    return (
      record.target instanceof HTMLElement &&
      (record.target.matches(OCCLUDING_LAYER_SELECTOR) ||
        layers.all.some((layer) => record.target.contains(layer)))
    );
  }
  return [...record.addedNodes, ...record.removedNodes].some(
    (node) =>
      node instanceof HTMLElement &&
      (node.matches(OCCLUDING_LAYER_SELECTOR) || !!node.querySelector(OCCLUDING_LAYER_SELECTOR)),
  );
}
