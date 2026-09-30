import { expect, it } from 'vitest';
import appConfig from '../../app.config';

// expo-widgets wipes and recreates its target, so the logo's asset catalog has to be written after
// it: Expo runs same-type mods last-registered first, so the logo plugin is listed just before.
it('registers the widget logo plugin immediately before expo-widgets', () => {
  const names = (appConfig({ config: { plugins: [] } } as never).plugins ?? []).map((plugin) =>
    Array.isArray(plugin) ? plugin[0] : plugin,
  );
  const widgets = names.indexOf('expo-widgets');
  expect(widgets).toBeGreaterThan(0);
  expect(names[widgets - 1]).toBe('./plugins/with-widget-logo.cjs');
});
