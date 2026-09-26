import { describe, expect, it } from 'vitest';
import {
  createHtmlArtifactPart,
  HTML_ARTIFACT_MAX_BODY_BYTES,
  HTML_ARTIFACT_MAX_TITLE_CODE_POINTS,
  isArtifactPreviewBoundsRequest,
  isArtifactPreviewClosedEvent,
  isArtifactPreviewCloseRequest,
  isArtifactPreviewOpenRequest,
  isHtmlArtifactData,
  isHtmlArtifactPart,
  validateHtmlArtifactInput,
} from './html-artifact';

describe('HTML artifact shared contract', () => {
  it('measures rendered body HTML in UTF-8 bytes and titles in Unicode code points', () => {
    const multibyteBody = '😀'.repeat(HTML_ARTIFACT_MAX_BODY_BYTES / 4);
    expect(validateHtmlArtifactInput('A', multibyteBody)).toEqual({
      ok: true,
      title: 'A',
      bodyHtml: multibyteBody,
    });
    expect(validateHtmlArtifactInput('A', `${multibyteBody}😀`)).toMatchObject({
      ok: false,
      reason: 'body_html_too_large',
    });

    expect(
      validateHtmlArtifactInput('😀'.repeat(HTML_ARTIFACT_MAX_TITLE_CODE_POINTS), '<p>ok</p>').ok,
    ).toBe(true);
    expect(
      validateHtmlArtifactInput('😀'.repeat(HTML_ARTIFACT_MAX_TITLE_CODE_POINTS + 1), '<p>ok</p>'),
    ).toMatchObject({ ok: false, reason: 'title_too_long' });
  });

  it('rejects blank rendered title or body HTML', () => {
    expect(validateHtmlArtifactInput(' ', '<p>ok</p>')).toMatchObject({
      ok: false,
      reason: 'blank_title',
    });
    expect(validateHtmlArtifactInput('Preview', ' \n ')).toMatchObject({
      ok: false,
      reason: 'blank_body_html',
    });
  });

  it.each([
    ['title high surrogate', '\ud800', '<p>ok</p>'],
    ['title low surrogate', '\udfff', '<p>ok</p>'],
    ['body high surrogate', 'Preview', '<p>\ud800</p>'],
    ['body low surrogate', 'Preview', '<p>\udfff</p>'],
    ['title NUL', 'Pre\0view', '<p>ok</p>'],
    ['body NUL', 'Preview', '<p>\0</p>'],
  ])('rejects non-persistable %s', (_case, title, bodyHtml) => {
    expect(validateHtmlArtifactInput(title, bodyHtml)).toEqual({
      ok: false,
      reason: 'invalid_unicode',
    });
  });

  it('persists a source-neutral part', () => {
    const first = createHtmlArtifactPart({
      artifactId: 'artifact-1',
      title: 'One',
      bodyHtml: '<p>one</p>',
    });
    expect(first).toEqual({
      type: 'data-html-artifact',
      data: { version: 1, artifactId: 'artifact-1', title: 'One', bodyHtml: '<p>one</p>' },
    });
  });

  it('excludes malformed current-version parts from rendering and deduplication', () => {
    const malformed = [
      { version: 1, artifactId: 'blank-title', title: '\n', bodyHtml: '<p>ok</p>' },
      { version: 1, artifactId: 'blank-body', title: 'Title', bodyHtml: '\t' },
      {
        version: 1,
        artifactId: 'oversized-body',
        title: 'Title',
        bodyHtml: 'x'.repeat(HTML_ARTIFACT_MAX_BODY_BYTES + 1),
      },
      {
        version: 1,
        artifactId: 'oversized-title',
        title: 'x'.repeat(HTML_ARTIFACT_MAX_TITLE_CODE_POINTS + 1),
        bodyHtml: '<p>ok</p>',
      },
    ];

    for (const data of malformed) {
      expect(isHtmlArtifactData(data)).toBe(false);
      expect(isHtmlArtifactPart({ type: 'data-html-artifact', data })).toBe(false);
    }
  });

  it('accepts only bounded, finite preview IPC payloads', () => {
    const artifact = {
      version: 1 as const,
      artifactId: 'artifact-1',
      title: 'Preview',
      bodyHtml: '<p>ok</p>',
    };
    const valid = {
      surfaceId: 'chat:single',
      bounds: { x: 0, y: 0, width: 400, height: 300 },
    };

    expect(isArtifactPreviewOpenRequest({ ...valid, artifact })).toBe(true);
    expect(isArtifactPreviewBoundsRequest(valid)).toBe(true);
    expect(isArtifactPreviewCloseRequest({ surfaceId: valid.surfaceId })).toBe(true);
    for (const reason of ['dismissed', 'failed', 'suspended']) {
      expect(isArtifactPreviewClosedEvent({ surfaceId: valid.surfaceId, reason })).toBe(true);
    }
    expect(isArtifactPreviewOpenRequest(null)).toBe(false);
    expect(isArtifactPreviewOpenRequest({ ...valid, artifact: { ...artifact, version: 2 } })).toBe(
      false,
    );
    expect(isArtifactPreviewOpenRequest({ ...valid, artifact, focusGuest: true })).toBe(false);
    expect(isArtifactPreviewBoundsRequest({ ...valid, surfaceId: '' })).toBe(false);
    expect(isArtifactPreviewBoundsRequest({ ...valid, surfaceId: 'x'.repeat(201) })).toBe(false);
    for (const bounds of [
      { x: Number.NaN, y: 0, width: 1, height: 1 },
      { x: 0, y: Number.POSITIVE_INFINITY, width: 1, height: 1 },
      { x: 0, y: 0, width: 0, height: 1 },
      { x: 0, y: 0, width: 1, height: 0 },
    ]) {
      expect(isArtifactPreviewBoundsRequest({ surfaceId: 'pane', bounds })).toBe(false);
    }
    expect(isArtifactPreviewCloseRequest({ surfaceId: '' })).toBe(false);
    expect(isArtifactPreviewClosedEvent({ surfaceId: '' })).toBe(false);
    expect(isArtifactPreviewClosedEvent({ surfaceId: valid.surfaceId })).toBe(false);
    expect(isArtifactPreviewClosedEvent({ surfaceId: valid.surfaceId, reason: 'unknown' })).toBe(
      false,
    );
  });
});
