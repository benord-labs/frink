// A spin class only lives in components/ui/spinner.tsx, which rotates an HTML box. On an svg,
// Chromium cannot composite the rotation at Frink's zoom, so it redraws every frame.
import { classLiteralRule } from './class-literal-rule.mjs';

export const noSvgSpin = classLiteralRule({
  pattern: /(?<![\w-])animate-(?:spin(?![\w])|\[spin(?=[_\]]))/g,
  messageId: 'svgSpin',
  description: 'Spinners rotate an HTML wrapper, never an svg.',
  message:
    '"{{match}}" on an icon redraws the whole app every frame at Frink\'s zoom. Use <Spinner> from components/ui/spinner (icon, speed and spinning props cover other icons).',
});
