import { memo, useEffect, useState } from 'react';
import { useCodeTheme } from '../../../lib/hooks/use-code-theme';
import { highlightCode } from '../../../lib/themes/shiki-theme-loader';
import { cn } from '../../../lib/utils';

type ShikiCodeBlockProps = {
  code: string;
  lang: string;
  className?: string;
  /** Renders the raw code as fallback while Shiki resolves. Default true. */
  showFallback?: boolean;
};

/**
 * Async Shiki-highlighted code block. Renders a `<pre>` with sanitised HTML
 * once Shiki resolves; before then renders the raw code in a plain `<pre>`
 * (skip with showFallback={false}). Theme follows the current useCodeTheme().
 */
export const ShikiCodeBlock = memo(function ShikiCodeBlock({
  code,
  lang,
  className,
  showFallback = true,
}: ShikiCodeBlockProps) {
  const [html, setHtml] = useState<string | null>(null);
  const themeId = useCodeTheme();

  useEffect(() => {
    let cancelled = false;
    highlightCode(code, lang, themeId)
      .then((result) => {
        if (!cancelled) setHtml(result);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [code, lang, themeId]);

  if (html) {
    return (
      <pre
        className={cn('[&>pre]:bg-transparent!', className)}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki produces sanitised HTML; caller is responsible for ensuring `code` is not user-controlled markup.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  if (!showFallback) return null;

  return (
    <pre className={cn('whitespace-pre-wrap wrap-break-word text-muted-foreground/70', className)}>
      {code}
    </pre>
  );
});
