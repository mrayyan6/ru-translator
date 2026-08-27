const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const coreRoot = path.resolve(projectRoot, '..', 'core');

const config = getDefaultConfig(projectRoot);

/**
 * `core/` lives outside this project directory, so Metro needs telling twice:
 * once to watch the folder for changes, and once to resolve the `@core/...`
 * specifier to it. The tsconfig `paths` entry only satisfies TypeScript —
 * without these two lines the build fails at runtime with an unresolved module.
 *
 * Untested: this project has never been compiled, because it needs the Android
 * SDK. Treat it as a starting point rather than a working configuration.
 */
config.watchFolders = [coreRoot];
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  '@core': coreRoot,
};

module.exports = config;
