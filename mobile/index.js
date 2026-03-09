// Must use require() (not import) to guarantee execution order before @solana/web3.js loads

// Shim Platform as a global — @solana/web3.js expects it as a global (old RN convention)
const { Platform } = require('react-native');
global.Platform = global.Platform || Platform;

require('react-native-get-random-values');
require('react-native-url-polyfill/auto');
const { Buffer } = require('buffer');
global.Buffer = global.Buffer || Buffer;

const { registerRootComponent } = require('expo');
const App = require('./App').default;

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
