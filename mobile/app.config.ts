import { execFileSync } from 'node:child_process';
import type { ConfigContext, ExpoConfig } from 'expo/config';

// The development variant installs beside the TestFlight app and loads JavaScript from Metro.
const development = process.env.APP_VARIANT === 'development';
const bundle = development ? 'dev.frink.mobile.dev' : 'dev.frink.mobile';

/** Output of a git query in this checkout, or undefined where there is no git (e.g. a build server). */
function git(...args: string[]): string | undefined {
  try {
    return (
      execFileSync('git', args, { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim() || undefined
    );
  } catch {
    return undefined;
  }
}

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...(config as ExpoConfig),
  // Which checkout's code the phone is running, shown on the connection screen.
  extra: {
    ...config.extra,
    source: {
      branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
      commit: git('rev-parse', '--short', 'HEAD'),
      checkout: git('rev-parse', '--show-toplevel')?.split('/').pop(),
    },
  },
  // The Lock Screen card's widget extension; each variant signs its own extension and app group.
  plugins: [
    ...(config.plugins ?? []),
    // Must stay immediately before expo-widgets, which would otherwise wipe the logo's asset catalog.
    './plugins/with-widget-logo.cjs',
    [
      'expo-widgets',
      {
        bundleIdentifier: `${bundle}.widgets`,
        groupIdentifier: `group.${bundle}`,
        enablePushNotifications: true,
      },
    ],
  ],
  ...(development && {
    name: 'Frink Dev',
    scheme: 'frink-mobile-dev',
    ios: { ...config.ios, bundleIdentifier: bundle },
  }),
});
