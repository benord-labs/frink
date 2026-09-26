// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PLUGIN_DEFINITIONS } from '../../../shared/integrations/plugins';
import { ProviderIcon } from './index';

afterEach(cleanup);

describe('ProviderIcon', () => {
  it.each(['slack', 'gmail'])('keeps the %s mark multicolour', (providerId) => {
    const { container } = render(<ProviderIcon providerId={providerId} />);
    const fills = new Set(
      [...container.querySelectorAll<SVGElement>('[fill]')].map((node) =>
        node.getAttribute('fill'),
      ),
    );

    expect(fills.size).toBeGreaterThan(1);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('keeps the official GitHub mark on the required tile appearance', () => {
    const { container } = render(<ProviderIcon providerId="github" appearance="tile" />);

    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('[fill="#161614"]')).toBeInTheDocument();
  });

  it.each([
    ['clickup', '%236647F0'],
    ['shortcut', '%23494BCB'],
  ])('uses the bundled official %s asset', (providerId, officialColour) => {
    const { container } = render(<ProviderIcon providerId={providerId} />);
    const image = container.querySelector('img');

    expect(image).toHaveAttribute('alt', '');
    expect(image?.getAttribute('src')).toContain(officialColour);
    expect(image).toHaveStyle({ objectFit: 'contain' });
  });

  it('renders a bundled mark for a catalog plugin', () => {
    const { container } = render(<ProviderIcon providerId="notion" appearance="tile" />);
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('.lucide-webhook')).toBeNull();
  });

  it.each([
    ['ashby', 'As'],
    ['canva', 'Ca'],
    ['circleback', 'Ci'],
    ['clay', 'Cl'],
    ['context7', 'Co'],
    ['juicebox', 'Ju'],
    ['navan', 'Na'],
    ['outreach', 'Ou'],
  ])('gives %s distinct initials when no vendor mark is published', (providerId, letter) => {
    const { container } = render(<ProviderIcon providerId={providerId} appearance="tile" />);
    const mark = container.querySelector('svg');

    expect(mark).toHaveAttribute('aria-hidden', 'true');
    expect(mark).toHaveStyle({ color: '#2D2D2D' });
    expect(mark?.querySelector('text')?.textContent).toBe(letter);
    expect(container.querySelector('.lucide-webhook')).toBeNull();
  });

  it('leaves initials inheriting colour when they are not on the tile', () => {
    const { container } = render(<ProviderIcon providerId="clay" />);

    expect(container.querySelector('svg')).not.toHaveStyle({ color: '#2D2D2D' });
  });

  // Guards the slug spelling every mark is keyed on, not the maps' own contents.
  it.each(PLUGIN_DEFINITIONS.filter((plugin) => plugin.id !== 'generic_webhook').map((p) => p.id))(
    'resolves a mark for the %s row',
    (providerId) => {
      const { container } = render(<ProviderIcon providerId={providerId} appearance="tile" />);

      expect(container.querySelector('img, svg')).not.toBeNull();
      expect(container.querySelector('.lucide-webhook')).toBeNull();
    },
  );

  it('keeps non-vendor providers generic', () => {
    const { container } = render(<ProviderIcon providerId="generic_webhook" appearance="tile" />);

    const icon = container.querySelector('svg.lucide-webhook');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    expect(icon).toHaveStyle({ color: '#2D2D2D' });
  });
});
