import type { MermaidConfig } from 'mermaid';

/** The Frink theme a diagram is painted in, as CSS colours. */
export type DiagramTheme = {
  dark: boolean;
  background: string;
  surface: string;
  node: string;
  nodeAlt: string;
  text: string;
  mutedText: string;
  accent: string;
  border: string;
  note: string;
};

function themeColor(style: CSSStyleDeclaration, name: string): string {
  return `hsl(${style.getPropertyValue(name).trim().split(/\s+/).join(', ')})`;
}

/**
 * Reads the active theme off <html>. The vars hold `H S% L%` triplets, and any Frink theme
 * repaints the same vars, so diagrams follow it. Reads computed style, so callers cache it.
 */
export function readDiagramTheme(root: HTMLElement = document.documentElement): DiagramTheme {
  const style = getComputedStyle(root);
  return {
    dark: root.classList.contains('dark'),
    background: themeColor(style, '--background'),
    surface: themeColor(style, '--card'),
    node: themeColor(style, '--secondary'),
    nodeAlt: themeColor(style, '--accent'),
    text: themeColor(style, '--foreground'),
    mutedText: themeColor(style, '--muted-foreground'),
    accent: themeColor(style, '--primary'),
    border: themeColor(style, '--border'),
    note: themeColor(style, '--muted'),
  };
}

/** Mermaid's `base` theme (the only one that honours every themeVariable) in Frink's colours. */
export function mermaidConfig(theme: DiagramTheme): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    // Without this Mermaid leaves a "Syntax error" SVG behind in <body> on every failed parse.
    suppressErrorRendering: true,
    fontFamily: 'inherit',
    theme: 'base',
    themeVariables: {
      darkMode: theme.dark,
      fontFamily: 'inherit',
      background: theme.background,
      primaryColor: theme.node,
      primaryTextColor: theme.text,
      primaryBorderColor: theme.accent,
      secondaryColor: theme.nodeAlt,
      tertiaryColor: theme.surface,
      lineColor: theme.mutedText,
      textColor: theme.text,
      noteBkgColor: theme.note,
      noteTextColor: theme.text,
      noteBorderColor: theme.border,
    },
  };
}
