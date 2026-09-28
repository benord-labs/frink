import type { ConfigContext, ExpoConfig } from 'expo/config';

// The development variant installs beside the TestFlight app and loads JavaScript from Metro.
const development = process.env.APP_VARIANT === 'development';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...(config as ExpoConfig),
  ...(development && {
    name: 'Frink Dev',
    scheme: 'frink-mobile-dev',
    ios: { ...config.ios, bundleIdentifier: 'dev.frink.mobile.dev' },
  }),
});
