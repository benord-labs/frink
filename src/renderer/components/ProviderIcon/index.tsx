import { Icon, type IconifyIcon } from '@iconify/react/offline';
import githubIcon from '@iconify-icons/logos/github-icon';
import googleGmailIcon from '@iconify-icons/logos/google-gmail';
import huggingFaceIcon from '@iconify-icons/logos/hugging-face-icon';
import linearIcon from '@iconify-icons/logos/linear-icon';
import slackIcon from '@iconify-icons/logos/slack-icon';
import asanaIconIcon from '@iconify-icons/logos/asana-icon';
import atlassianIcon from '@iconify-icons/logos/atlassian';
import cloudflareIconIcon from '@iconify-icons/logos/cloudflare-icon';
import figmaIcon from '@iconify-icons/logos/figma';
import googleCalendarIcon from '@iconify-icons/logos/google-calendar';
import googleDriveIcon from '@iconify-icons/logos/google-drive';
import hubspotIcon from '@iconify-icons/logos/hubspot';
import intercomIconIcon from '@iconify-icons/logos/intercom-icon';
import neonIconIcon from '@iconify-icons/logos/neon-icon';
import notionIconIcon from '@iconify-icons/logos/notion-icon';
import paypalIcon from '@iconify-icons/logos/paypal';
import playwrightIcon from '@iconify-icons/logos/playwright';
import posthogIconIcon from '@iconify-icons/logos/posthog-icon';
import salesforceIcon from '@iconify-icons/logos/salesforce';
import sentryIconIcon from '@iconify-icons/logos/sentry-icon';
import squareIcon from '@iconify-icons/logos/square';
import supabaseIconIcon from '@iconify-icons/logos/supabase-icon';
import vercelIconIcon from '@iconify-icons/logos/vercel-icon';
import webflowIcon from '@iconify-icons/logos/webflow';
import xIcon from '@iconify-icons/logos/x';
import zoomIconIcon from '@iconify-icons/logos/zoom-icon';
import { Webhook } from 'lucide-react';
import type { CSSProperties } from 'react';
import amplemarketIcon from '../../assets/provider-logos/amplemarket.svg';
import clickupIcon from '../../assets/provider-logos/clickup.svg';
import docusignIcon from '../../assets/provider-logos/docusign.svg';
import gongIcon from '../../assets/provider-logos/gong.svg';
import profoundIcon from '../../assets/provider-logos/profound.svg';
import shortcutIcon from '../../assets/provider-logos/shortcut.svg';

type Appearance = 'inline' | 'tile';

type Props = {
  providerId: string;
  appearance?: Appearance;
  className?: string;
  style?: CSSProperties;
};

const ICONS = new Map<string, IconifyIcon>([
  ['github', githubIcon],
  ['gmail', googleGmailIcon],
  ['slack', slackIcon],
  ['linear', linearIcon],
  ['asana', asanaIconIcon],
  ['atlassian', atlassianIcon],
  ['cloudflare', cloudflareIconIcon],
  ['figma', figmaIcon],
  ['google-calendar', googleCalendarIcon],
  ['google-drive', googleDriveIcon],
  ['hubspot', hubspotIcon],
  ['intercom', intercomIconIcon],
  ['neon', neonIconIcon],
  ['notion', notionIconIcon],
  ['paypal', paypalIcon],
  ['playwright', playwrightIcon],
  ['posthog', posthogIconIcon],
  ['salesforce', salesforceIcon],
  ['sentry', sentryIconIcon],
  ['square', squareIcon],
  ['supabase', supabaseIconIcon],
  ['vercel', vercelIconIcon],
  ['webflow', webflowIcon],
  ['x', xIcon],
  ['huggingface', huggingFaceIcon],
  ['zoom', zoomIconIcon],
]);

const ASSETS = new Map<string, string>([
  ['amplemarket', amplemarketIcon],
  ['clickup', clickupIcon],
  ['docusign', docusignIcon],
  ['gong', gongIcon],
  ['profound', profoundIcon],
  ['shortcut', shortcutIcon],
]);

/** Vendors whose mark is published in no licensed corpus; their rows carry initials instead. */
const NO_MARK = new Set([
  'ashby',
  'canva',
  'circleback',
  'clay',
  'context7',
  'juicebox',
  'navan',
  'outreach',
]);

const BRAND_TILE = '#E8E8E8';
const BRAND_TILE_RIM = 'inset 0 0 0 1px rgb(0 0 0 / 12%)';

/** Fixed light substrate required by the bundled vendor marks in both app themes. */
export const BRAND_TILE_STYLE = { background: BRAND_TILE } satisfies CSSProperties;

/** Inner rim keeps the light tile visible against the light-theme row. */
export const BRAND_TILE_RIM_STYLE = {
  background: BRAND_TILE,
  boxShadow: BRAND_TILE_RIM,
} satisfies CSSProperties;

/** Generic marks need dark ink when rendered on the fixed light brand tile. */
const GENERIC_TILE_INK = '#2D2D2D';
const GENERIC_TILE_STYLE = { color: GENERIC_TILE_INK } satisfies CSSProperties;

/** Two letters, because four catalog slugs start with the same one. */
function initials(providerId: string): string {
  return providerId.charAt(0).toUpperCase() + providerId.charAt(1);
}

function inkOnTile(appearance: Appearance, style?: CSSProperties): CSSProperties | undefined {
  if (appearance !== 'tile') return style;
  return style ? { ...style, color: GENERIC_TILE_INK } : GENERIC_TILE_STYLE;
}

/** Bundled provider identity; unknown/non-vendor providers keep the generic Webhook glyph. */
export function ProviderIcon({ providerId, appearance = 'inline', className, style }: Props) {
  const icon = ICONS.get(providerId);
  if (icon) {
    return <Icon icon={icon} className={className} style={style} aria-hidden />;
  }

  const asset = ASSETS.get(providerId);
  if (asset) {
    return (
      <img
        src={asset}
        alt=""
        className={className}
        style={{ ...style, objectFit: 'contain' }}
        draggable={false}
      />
    );
  }

  if (NO_MARK.has(providerId)) {
    return (
      <svg
        viewBox="0 0 24 24"
        className={className}
        style={inkOnTile(appearance, style)}
        aria-hidden
      >
        <text
          x="12"
          y="12"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize="11"
          fontWeight="600"
          fill="currentColor"
        >
          {initials(providerId)}
        </text>
      </svg>
    );
  }

  return <Webhook className={className} style={inkOnTile(appearance, style)} aria-hidden />;
}
