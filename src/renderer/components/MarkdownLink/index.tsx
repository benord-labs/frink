import githubLogo from '@iconify-icons/simple-icons/github';
import { Globe } from 'lucide-react';
import type { ComponentProps } from 'react';
import type { ExtraProps } from 'streamdown';
import { isAllowedShellOpenExternalUrl } from '../../../shared/shell-external-url';
import { iconifyComponent } from '../../lib/utils/iconify-component';

const GitHubIcon = iconifyComponent(githubLogo);

type LinkContent = NonNullable<ExtraProps['node']>['children'][number];

/** Whether a link has words for an icon to sit beside; a link around only an image has none. */
function hasWords(content: LinkContent): boolean {
  if (content.type === 'text') return content.value.trim() !== '';
  return content.type === 'element' && content.children.some(hasWords);
}

/** The host of a link that opens a website; null for mail and for links the app does not open. */
function websiteHost(href: string | undefined): string | null {
  if (!href || !isAllowedShellOpenExternalUrl(href)) return null;
  const { protocol, hostname } = new URL(href.trim());
  return protocol === 'mailto:' ? null : hostname;
}

/** A link in rendered markdown: opens in the system browser, and a website link leads with an icon. */
export function MarkdownLink({ href, children, ...props }: ComponentProps<'a'> & ExtraProps) {
  const host = !props.node || hasWords(props.node) ? websiteHost(href) : null;
  const Icon = host === 'github.com' || host?.endsWith('.github.com') ? GitHubIcon : Globe;
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href && isAllowedShellOpenExternalUrl(href)) {
          void window.desktopApi.openExternal(href);
        }
      }}
      className="text-blue-600 dark:text-blue-400 no-underline hover:underline hover:decoration-current underline-offset-2 decoration-1 transition-all duration-150 cursor-pointer focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-blue-500/30 focus-visible:rounded-sm"
      {...props}
    >
      {host !== null && (
        // An icon in the text flow lets a line break on either side of it. This empty span only
        // holds the room; the icon is drawn over it, outside the flow.
        <span aria-hidden className="relative ps-4.5">
          <Icon className="absolute inset-y-0 inset-s-0 my-auto size-3.5" />
        </span>
      )}
      {children}
    </a>
  );
}
