import { expect, it } from 'vitest';
import app from '../../../app.json';

// Without it iOS quietly delivers a "needs you" alert as an ordinary one, held back by Focus.
it('lets time-sensitive alerts through Focus', () => {
  expect(app.expo.ios).toMatchObject({
    entitlements: { 'com.apple.developer.usernotifications.time-sensitive': true },
  });
});
