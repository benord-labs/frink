import {
  clampChroma,
  type Color,
  converter,
  formatHex,
  interpolate,
  modeHsl,
  modeLrgb,
  modeOklab,
  modeOklch,
  modeRgb,
  type Oklch,
  parse,
  useMode as registerMode,
  wcagContrast,
} from 'culori/fn';

// culori/fn is tree-shaken: only these colour spaces can be parsed or converted.
registerMode(modeRgb);
registerMode(modeLrgb);
registerMode(modeHsl);
registerMode(modeOklab);
registerMode(modeOklch);

const toHsl = converter('hsl');
const toRgb = converter('rgb');
const toOklchColor = converter('oklch');

export { wcagContrast as contrastRatio };

/** Palette colours are schema-validated hex, so a parse miss is a programming error. */
function mustParse(value: string): Color {
  const color = parse(value);
  if (!color) throw new Error(`Not a CSS colour: ${value}`);
  return color;
}

/** Any CSS colour → lowercase `#rrggbb` (alpha dropped); undefined when unparseable. */
export function toHex(value: string): string | undefined {
  const color = parse(value);
  return color && formatHex(color);
}

export function toOklch(hex: string): Oklch {
  return toOklchColor(mustParse(hex));
}

/** Out-of-gamut chroma is reduced (hue and lightness kept) before rounding to hex. */
export function oklchHex(l: number, c: number, h = 0): string {
  return formatHex(clampChroma({ mode: 'oklch', l, c, h }, 'oklch'));
}

export function isDarkColor(hex: string): boolean {
  return wcagContrast(hex, '#000000') < wcagContrast(hex, '#ffffff');
}

/** `t` of the way from `from` to `to`, mixed in OKLab. */
export function mixOklab(from: string, to: string, t: number): string {
  return formatHex(interpolate([from, to], 'oklab')(t));
}

const oneDecimal = (n: number): number => Number(n.toFixed(1));

/** `#rrggbb` → Frink's `H S% L%` token format (1 decimal round-trips every hex exactly). */
export function hexToHslTriplet(hex: string): string {
  const { h = 0, s, l } = toHsl(mustParse(hex));
  return `${oneDecimal(h)} ${oneDecimal(s * 100)}% ${oneDecimal(l * 100)}%`;
}

export function hslTripletToHex(triplet: string): string {
  return formatHex(mustParse(`hsl(${triplet.trim()})`));
}

/** `#rrggbb` → `r g b` (0–255), the format of `--chat-atmosphere-floor`. */
export function hexToRgbTriplet(hex: string): string {
  const { r, g, b } = toRgb(mustParse(hex));
  return [r, g, b].map((channel) => Math.round(channel * 255)).join(' ');
}
