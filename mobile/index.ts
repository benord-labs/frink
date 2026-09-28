// Richer launch and error screens in Frink Dev; a no-op in TestFlight and web builds.
import 'expo-dev-client';
import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
