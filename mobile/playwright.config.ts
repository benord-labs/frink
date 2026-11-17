import { defineConfig } from '@playwright/test';

// Parallel checkouts each preview on their own port (never 8081, which the phone uses).
const port = Number(process.env.MOBILE_WEB_PORT ?? 8093);

export default defineConfig({
  testDir: './tests',
  // Fixtures load ../src/shared, whose tweetnacl/zod must resolve from mobile/node_modules (as in Metro).
  tsconfig: './tsconfig.json',
  // Traces live in a subfolder Playwright may wipe; review screenshots stay in test-results/.
  outputDir: 'test-results/runs',
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 390, height: 844 },
    colorScheme: 'dark',
    hasTouch: true,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `bunx expo start --web --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    timeout: 120000,
    env: { CI: '1', BROWSER: 'none' },
  },
});
