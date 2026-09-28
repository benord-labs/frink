import { execFileSync } from 'node:child_process';
import type { ConfigContext, ExpoConfig } from 'expo/config';

// The development variant installs beside the TestFlight app and loads JavaScript from Metro.
const development = process.env.APP_VARIANT === 'development';

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
  ...(development && {
    name: 'Frink Dev',
    scheme: 'frink-mobile-dev',
    ios: { ...config.ios, bundleIdentifier: 'dev.frink.mobile.dev' },
  }),
});
