import * as shiki from 'shiki';
import { DEFAULT_SYNTAX } from './palette/theme-schema';

/**
 * Shared Shiki highlighter instance
 * Initialized with default themes, can load additional themes dynamically
 */
let highlighterPromise: Promise<shiki.Highlighter> | null = null;

// ============================================================================
// LRU CACHE FOR HIGHLIGHT RESULTS
// ============================================================================
// Prevents re-highlighting the same code when switching tabs.
// Key: `${themeId}:${language}:${code}` -> Value: highlighted HTML
// Max 500 entries (~5MB assuming 10KB average per entry)
const HIGHLIGHT_CACHE_MAX_SIZE = 500;

class LRUCache<K, V> {
  private cache = new Map<K, V>();
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    // Delete first to ensure it's at the end
    this.cache.delete(key);
    this.cache.set(key, value);

    // Evict oldest entries if over capacity
    if (this.cache.size > this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }
}

const highlightCache = new LRUCache<string, string>(HIGHLIGHT_CACHE_MAX_SIZE);

/**
 * Languages supported by the highlighter
 */
const SUPPORTED_LANGUAGES: shiki.BundledLanguage[] = [
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'html',
  'css',
  'json',
  'yaml',
  'python',
  'go',
  'rust',
  'bash',
  'markdown',
];

// Every other bundled theme loads on first use, once however many code blocks ask at once.
const themeLoads = new Map<string, Promise<void>>();

/**
 * Regex to extract code content from Shiki's HTML output
 */
const CODE_CONTENT_REGEX = /<code[^>]*>([\s\S]*?)<\/code>/;

/**
 * Map common short aliases to their canonical Shiki language names.
 * Shiki's getLoadedLanguages() returns canonical names only, but markdown
 * code fences frequently use short aliases (e.g. ```ts instead of ```typescript).
 */
const LANGUAGE_ALIASES: Record<string, shiki.BundledLanguage> = {
  ts: 'typescript',
  js: 'javascript',
  py: 'python',
  rs: 'rust',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  md: 'markdown',
  yml: 'yaml' as shiki.BundledLanguage,
};

function loadTheme(highlighter: shiki.Highlighter, themeId: string): Promise<void> {
  let load = themeLoads.get(themeId);
  if (!load) {
    // SAFETY: theme ids come from a decoded ThemeDefinition, whose syntax is a BundledTheme.
    load = highlighter
      .loadTheme(themeId as shiki.BundledTheme)
      .finally(() => themeLoads.delete(themeId));
    themeLoads.set(themeId, load);
  }
  return load;
}

/**
 * Get or create the Shiki highlighter instance
 */
async function getHighlighter(): Promise<shiki.Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = shiki.createHighlighter({
      themes: Object.values(DEFAULT_SYNTAX),
      langs: SUPPORTED_LANGUAGES,
    });
  }
  return highlighterPromise;
}

/**
 * Highlight code with a Shiki bundled theme (the active palette's syntax pairing).
 * Results are cached to prevent re-highlighting when switching tabs
 */
export async function highlightCode(
  code: string,
  language: string,
  themeId: string,
): Promise<string> {
  const highlighter = await getHighlighter();
  if (!highlighter.getLoadedThemes().includes(themeId)) await loadTheme(highlighter, themeId);

  const loadedLangs = highlighter.getLoadedLanguages();
  const resolved = LANGUAGE_ALIASES[language] ?? language;
  const lang = loadedLangs.includes(resolved as shiki.BundledLanguage)
    ? (resolved as shiki.BundledLanguage)
    : 'plaintext';
  const cacheKey = `${themeId}:${lang}:${code}`;
  const cached = highlightCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const html = highlighter.codeToHtml(code, { lang, theme: themeId });

  // Extract just the code content from shiki's output (remove wrapper)
  const match = html.match(CODE_CONTENT_REGEX);
  const result = match ? match[1] : code;

  // Cache the result
  highlightCache.set(cacheKey, result);

  return result;
}
