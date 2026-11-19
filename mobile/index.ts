// Richer launch and error screens in Frink Dev; a no-op in TestFlight and web builds.
import 'expo-dev-client';
import { registerRootComponent } from 'expo';
import { AppState } from 'react-native';
import App from './App';
import { watchRelayLifecycle } from './src/lib/relay/client';

// Registered before any screen, so a returning app dials the Mac before its polls fire.
watchRelayLifecycle(AppState);
registerRootComponent(App);
