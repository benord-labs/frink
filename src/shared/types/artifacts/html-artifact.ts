export const HTML_ARTIFACT_PART_TYPE = 'data-html-artifact' as const;

export const ARTIFACT_PREVIEW_CHANNELS = {
  open: 'artifact-preview:open',
  focus: 'artifact-preview:focus',
  updateBounds: 'artifact-preview:update-bounds',
  close: 'artifact-preview:close',
  closed: 'artifact-preview:closed',
  focusReturned: 'artifact-preview:focus-returned',
  isHostFocused: 'artifact-preview:is-host-focused',
} as const;

export type HtmlArtifactData = {
  version: 1;
  artifactId: string;
  title: string;
  bodyHtml: string;
};

export type HtmlArtifactPart = {
  type: typeof HTML_ARTIFACT_PART_TYPE;
  data: HtmlArtifactData;
};

export type ArtifactPreviewBounds = { x: number; y: number; width: number; height: number };
export type ArtifactPreviewOpenRequest = {
  surfaceId: string;
  artifact: HtmlArtifactData;
  bounds: ArtifactPreviewBounds;
};
export type ArtifactPreviewBoundsRequest = {
  surfaceId: string;
  bounds: ArtifactPreviewBounds;
};
export type ArtifactPreviewCloseRequest = { surfaceId: string };
export type ArtifactPreviewClosedEvent = {
  surfaceId: string;
  reason: 'dismissed' | 'failed' | 'suspended';
};
export type ArtifactPreviewFocusReturnedEvent = { surfaceId: string };
