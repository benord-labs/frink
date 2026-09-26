// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { CustomNodeRegistrationPresentation } from '../../../../../../shared/types/permissions';
import { CustomNodeRegistrationPreview } from './index';

function makePresentation(): CustomNodeRegistrationPresentation {
  return {
    type: 'custom-node-registration',
    packagePath: 'examples/custom-nodes/folder-label',
    action: 'create',
    node: {
      name: 'read-colocated-image',
      displayName: 'Trusted Reader',
      description: 'Reads an image next to the entrypoint.',
      version: '1.0.0',
      entrypoint: 'index.js',
    },
    source: {
      current: "console.log('<script>alert(1)</script>');\n",
    },
    modules: [
      {
        path: 'lib/helper.js',
        current: "export const value = '<img onerror=alert(1)>';\n",
        change: 'added',
      },
    ],
    resources: [
      { path: 'cinder.png', bytes: 91, change: 'added' },
      { path: 'notes.txt', bytes: 12, change: 'unchanged' },
    ],
    credentialNames: ['github'],
    test: { config: { query: '<unsafe>' }, timeoutMs: 10_000 },
    packageDigest: 'a'.repeat(64),
    packageBytes: 347,
    warning: 'Runs unsandboxed and can also execute later from unattended Flows.',
  };
}

describe('CustomNodeRegistrationPreview', () => {
  it('discloses the manifest identity, package snapshot, resources, credentials, and test', () => {
    render(<CustomNodeRegistrationPreview presentation={makePresentation()} />);

    expect(
      screen.getByText(
        (_content, element) =>
          element?.tagName === 'STRONG' && element.textContent === 'Register “Trusted Reader”?',
      ),
    ).toBeTruthy();
    expect(screen.getByText('read-colocated-image')).toBeTruthy();
    expect(screen.getByText('examples/custom-nodes/folder-label')).toBeTruthy();
    expect(screen.getByText('cinder.png')).toBeTruthy();
    expect(screen.getByText('lib/helper.js')).toBeTruthy();
    expect(screen.getByText(/<img onerror=alert\(1\)>/)).toBeTruthy();
    expect(screen.getByText('added')).toBeTruthy();
    expect(screen.getByText('unchanged')).toBeTruthy();
    expect(screen.getByText(/Requested credentials:/).parentElement?.textContent).toContain(
      'github',
    );
    expect(screen.getByText(/"query": "<unsafe>"/)).toBeTruthy();
    expect(screen.getByText('a'.repeat(64))).toBeTruthy();
    expect(screen.getByText(/Runs unsandboxed/)).toBeTruthy();
  });

  it('labels an inline registration and warns when it replaces a folder package', () => {
    const presentation = makePresentation();
    presentation.packagePath = undefined;
    presentation.action = 'replace';
    presentation.replacesPackage = true;
    render(<CustomNodeRegistrationPreview presentation={presentation} />);

    expect(screen.getByText(/from inline script/)).toBeTruthy();
    expect(screen.getByText(/replaces a folder-installed node/)).toBeTruthy();
  });

  it('renders source as escaped text and expands from the keyboard with aria state', async () => {
    const user = userEvent.setup();
    const presentation = makePresentation();
    presentation.action = 'replace';
    presentation.source = {
      previous: "console.log('old');\n",
      current: [
        "console.log('<script>alert(1)</script>');",
        'const lineTwo = true;',
        'const lineThree = true;',
        'const lineFour = true;',
        'const lineFive = true;',
        'const lineSix = true;',
        'const lineSeven = true;',
        'const lineEight = true;',
      ].join('\n'),
    };
    presentation.resources = [
      { path: 'old.png', bytes: 20, change: 'removed' },
      { path: 'cinder.png', bytes: 91, change: 'changed' },
    ];
    const { container } = render(<CustomNodeRegistrationPreview presentation={presentation} />);

    expect(
      screen.getByText(
        (_content, element) =>
          element?.tagName === 'STRONG' && element.textContent === 'Replace “Trusted Reader”?',
      ),
    ).toBeTruthy();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
    expect(screen.getByText('Removed:')).toBeTruthy();
    expect(screen.getAllByText('Added:').length).toBeGreaterThan(0);
    expect(screen.getByText('removed')).toBeTruthy();
    expect(screen.getByText('changed')).toBeTruthy();
    expect(screen.queryByText('const lineEight = true;')).toBeNull();
    expect(screen.getByText(/more source lines hidden/i)).toBeTruthy();

    const expand = screen.getByRole('button', { name: /Expand source/i });
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    await user.tab();
    expect(document.activeElement).toBe(expand);
    await user.keyboard('{Enter}');
    expect(
      screen.getByRole('button', { name: /Collapse source/i }).getAttribute('aria-expanded'),
    ).toBe('true');
    expect(screen.getByText('const lineEight = true;')).toBeTruthy();
    expect(screen.queryByText(/more source lines hidden/i)).toBeNull();
  });

  it('makes hostile bidi and control characters visible in every preview field', () => {
    const presentation = makePresentation();
    presentation.node.displayName = 'Trusted\u202eReader';
    presentation.node.name = 'read\u2067-image';
    presentation.node.description = 'Reads\u202dan image';
    presentation.node.version = '1.0\u0009.0';
    presentation.node.entrypoint = 'index\u2068.js';
    presentation.packagePath = 'examples/\u2066folder';
    presentation.source.current = "console.log('\u2069');\n";
    presentation.resources = [{ path: 'cin\u202eder.png', bytes: 91, change: 'added' }];
    presentation.credentialNames = ['git\u200fhub'];
    presentation.test = { config: { query: 'safe\u202avalue' }, timeoutMs: 10_000 };
    presentation.warning = 'Runs\u202bunsandboxed.';

    const { container } = render(<CustomNodeRegistrationPreview presentation={presentation} />);
    const text = container.textContent ?? '';

    expect(text).not.toMatch(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
    for (const marker of [
      '⟦RLO U+202E⟧',
      '⟦RLI U+2067⟧',
      '⟦LRO U+202D⟧',
      '⟦TAB U+0009⟧',
      '⟦FSI U+2068⟧',
      '⟦LRI U+2066⟧',
      '⟦PDI U+2069⟧',
      '⟦RLM U+200F⟧',
      '⟦LRE U+202A⟧',
      '⟦RLE U+202B⟧',
    ]) {
      expect(text).toContain(marker);
    }
  });

  it('isolates ordinary right-to-left values from trusted labels and punctuation', () => {
    const presentation = makePresentation();
    presentation.node.displayName = 'قارئ موثوق';
    presentation.node.description = 'يقرأ صورة';
    presentation.resources = [{ path: 'صورة.png', bytes: 91, change: 'added' }];
    presentation.credentialNames = ['مفتاح'];

    const { container } = render(<CustomNodeRegistrationPreview presentation={presentation} />);
    const isolatedValues = [...container.querySelectorAll('bdi[dir="auto"]')].map(
      (element) => element.textContent,
    );

    expect(isolatedValues).toEqual(
      expect.arrayContaining(['قارئ موثوق', 'يقرأ صورة', 'صورة.png', 'مفتاح']),
    );
  });
});
