import { z } from 'zod';
import {
  type ArtifactPreviewBounds,
  type ArtifactPreviewBoundsRequest,
  type ArtifactPreviewClosedEvent,
  type ArtifactPreviewCloseRequest,
  type ArtifactPreviewFocusReturnedEvent,
  type ArtifactPreviewOpenRequest,
  HTML_ARTIFACT_PART_TYPE,
  type HtmlArtifactData,
  type HtmlArtifactPart,
} from '../../types/artifacts/html-artifact';

export const HTML_ARTIFACT_MAX_TITLE_CODE_POINTS = 120;
export const HTML_ARTIFACT_MAX_BODY_BYTES = 65_536;
const MAX_SURFACE_ID_CODE_POINTS = 200;

export type HtmlArtifactValidation =
  | { ok: true; title: string; bodyHtml: string }
  | {
      ok: false;
      reason:
        | 'invalid_unicode'
        | 'blank_title'
        | 'title_too_long'
        | 'blank_body_html'
        | 'body_html_too_large';
    };

function isPersistableText(value: string): boolean {
  if (value.includes('\0')) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function validateHtmlArtifactInput(
  renderedTitle: string,
  renderedBodyHtml: string,
): HtmlArtifactValidation {
  if (!isPersistableText(renderedTitle) || !isPersistableText(renderedBodyHtml)) {
    return { ok: false, reason: 'invalid_unicode' };
  }
  const title = renderedTitle.trim();
  if (title.length === 0) return { ok: false, reason: 'blank_title' };
  if (Array.from(title).length > HTML_ARTIFACT_MAX_TITLE_CODE_POINTS) {
    return { ok: false, reason: 'title_too_long' };
  }
  if (renderedBodyHtml.trim().length === 0) return { ok: false, reason: 'blank_body_html' };
  const bodyBytes = utf8ByteLength(renderedBodyHtml);
  if (bodyBytes > HTML_ARTIFACT_MAX_BODY_BYTES) {
    return { ok: false, reason: 'body_html_too_large' };
  }
  return { ok: true, title, bodyHtml: renderedBodyHtml };
}

export function createHtmlArtifactPart(data: Omit<HtmlArtifactData, 'version'>): HtmlArtifactPart {
  return { type: HTML_ARTIFACT_PART_TYPE, data: { version: 1, ...data } };
}

const htmlArtifactDataSchema: z.ZodType<HtmlArtifactData> = z
  .object({
    version: z.literal(1),
    artifactId: z.string().min(1),
    title: z.string(),
    bodyHtml: z.string(),
  })
  .refine(({ title, bodyHtml }) => validateHtmlArtifactInput(title, bodyHtml).ok);
const htmlArtifactPartSchema: z.ZodType<HtmlArtifactPart> = z.object({
  type: z.literal(HTML_ARTIFACT_PART_TYPE),
  data: htmlArtifactDataSchema,
});
const surfaceIdSchema = z
  .string()
  .min(1)
  .refine((surfaceId) => Array.from(surfaceId).length <= MAX_SURFACE_ID_CODE_POINTS);
const artifactPreviewBoundsSchema: z.ZodType<ArtifactPreviewBounds> = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
});
const artifactPreviewOpenRequestSchema: z.ZodType<ArtifactPreviewOpenRequest> = z
  .object({
    surfaceId: surfaceIdSchema,
    artifact: htmlArtifactDataSchema,
    bounds: artifactPreviewBoundsSchema,
  })
  .strict();
const artifactPreviewBoundsRequestSchema: z.ZodType<ArtifactPreviewBoundsRequest> = z.object({
  surfaceId: surfaceIdSchema,
  bounds: artifactPreviewBoundsSchema,
});
const artifactPreviewCloseRequestSchema: z.ZodType<ArtifactPreviewCloseRequest> = z.object({
  surfaceId: surfaceIdSchema,
});
const artifactPreviewClosedEventSchema: z.ZodType<ArtifactPreviewClosedEvent> = z.object({
  surfaceId: surfaceIdSchema,
  reason: z.enum(['dismissed', 'failed', 'suspended']),
});
const artifactPreviewFocusReturnedEventSchema: z.ZodType<ArtifactPreviewFocusReturnedEvent> =
  z.object({ surfaceId: surfaceIdSchema });

type HtmlArtifactDataWireValue = Parameters<typeof htmlArtifactDataSchema.safeParse>[0];
type HtmlArtifactPartWireValue = Parameters<typeof htmlArtifactPartSchema.safeParse>[0];
type ArtifactPreviewOpenWireValue = Parameters<
  typeof artifactPreviewOpenRequestSchema.safeParse
>[0];
type ArtifactPreviewBoundsWireValue = Parameters<
  typeof artifactPreviewBoundsRequestSchema.safeParse
>[0];
type ArtifactPreviewCloseWireValue = Parameters<
  typeof artifactPreviewCloseRequestSchema.safeParse
>[0];
type ArtifactPreviewClosedWireValue = Parameters<
  typeof artifactPreviewClosedEventSchema.safeParse
>[0];
type ArtifactPreviewFocusReturnedWireValue = Parameters<
  typeof artifactPreviewFocusReturnedEventSchema.safeParse
>[0];

export function isHtmlArtifactData(value: HtmlArtifactDataWireValue): value is HtmlArtifactData {
  return htmlArtifactDataSchema.safeParse(value).success;
}

export function isHtmlArtifactPart(value: HtmlArtifactPartWireValue): value is HtmlArtifactPart {
  return htmlArtifactPartSchema.safeParse(value).success;
}

export function isArtifactPreviewOpenRequest(
  value: ArtifactPreviewOpenWireValue,
): value is ArtifactPreviewOpenRequest {
  return artifactPreviewOpenRequestSchema.safeParse(value).success;
}

export function isArtifactPreviewBoundsRequest(
  value: ArtifactPreviewBoundsWireValue,
): value is ArtifactPreviewBoundsRequest {
  return artifactPreviewBoundsRequestSchema.safeParse(value).success;
}

export function isArtifactPreviewCloseRequest(
  value: ArtifactPreviewCloseWireValue,
): value is ArtifactPreviewCloseRequest {
  return artifactPreviewCloseRequestSchema.safeParse(value).success;
}

export function isArtifactPreviewClosedEvent(
  value: ArtifactPreviewClosedWireValue,
): value is ArtifactPreviewClosedEvent {
  return artifactPreviewClosedEventSchema.safeParse(value).success;
}

export function isArtifactPreviewFocusReturnedEvent(
  value: ArtifactPreviewFocusReturnedWireValue,
): value is ArtifactPreviewFocusReturnedEvent {
  return artifactPreviewFocusReturnedEventSchema.safeParse(value).success;
}
