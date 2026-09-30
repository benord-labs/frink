// Ships the Frink F mark to the Lock Screen card's widget extension. expo-widgets has no asset
// support and gives its target no Resources phase, so this writes a template image set into the
// target's asset catalog and compiles it with an actool build phase (after t3code's recipe).
//
// Must be listed immediately BEFORE expo-widgets in app.config.ts: Expo runs same-type mods
// last-registered first, and expo-widgets' mods delete ios/ExpoWidgetsTarget and create the target,
// so listed after it this silently ships a card without its logo.
const fs = require('node:fs');
const path = require('node:path');
const { withDangerousMod, withXcodeProject } = require('expo/config-plugins');

const TARGET = 'ExpoWidgetsTarget';
const PHASE = 'Compile Widget Assets';
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const info = { author: 'expo', version: 1 };

// A Resources phase added by hand is never scheduled by xcodebuild, so actool runs as a script.
const ACTOOL = [
  'set -e',
  'CATALOG="${SRCROOT}/ExpoWidgetsTarget/Assets.xcassets"',
  'if [ ! -d "$CATALOG" ]; then',
  '  echo "error: widget asset catalog missing at $CATALOG (check plugin order in app.config.ts)"',
  '  exit 1',
  'fi',
  'DEST="${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}"',
  'mkdir -p "$DEST"',
  'xcrun actool "$CATALOG" --compile "$DEST" --platform "${PLATFORM_NAME}" --minimum-deployment-target "${IPHONEOS_DEPLOYMENT_TARGET:-16.0}" --output-format human-readable-text',
].join('\n');

function withAsset(config) {
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const catalog = path.join(cfg.modRequest.platformProjectRoot, TARGET, 'Assets.xcassets');
      const imageSet = path.join(catalog, 'FrinkMark.imageset');
      fs.mkdirSync(imageSet, { recursive: true });
      fs.writeFileSync(path.join(catalog, 'Contents.json'), json({ info }));
      fs.writeFileSync(
        path.join(imageSet, 'Contents.json'),
        json({
          images: [{ idiom: 'universal', filename: 'frink-mark.svg' }],
          info,
          properties: {
            'preserves-vector-representation': true,
            'template-rendering-intent': 'template',
          },
        }),
      );
      fs.copyFileSync(
        path.join(cfg.modRequest.projectRoot, 'assets', 'widget', 'frink-mark.svg'),
        path.join(imageSet, 'frink-mark.svg'),
      );
      return cfg;
    },
  ]);
}

function withActoolPhase(config) {
  return withXcodeProject(config, (cfg) => {
    const objects = cfg.modResults.hash.project.objects;
    const entries = (map) => Object.entries(map ?? {}).filter(([key]) => !key.endsWith('_comment'));
    const target = entries(objects.PBXNativeTarget).find(([, value]) => value.name === TARGET);
    // Skipping would ship a card without its logo, so a missing target is a build error.
    if (!target)
      throw new Error(`with-widget-logo: ${TARGET} not found; list it before expo-widgets`);
    const phases = target[1].buildPhases ?? [];
    const present = entries(objects.PBXShellScriptBuildPhase).some(
      ([uuid, value]) =>
        value.name === `"${PHASE}"` && phases.some((phase) => phase.value === uuid),
    );
    if (present) return cfg;
    const { uuid } = cfg.modResults.addBuildPhase(
      [],
      'PBXShellScriptBuildPhase',
      PHASE,
      target[0],
      {
        shellPath: '/bin/sh',
        shellScript: ACTOOL,
      },
    );
    // Always run: input analysis is what skips a Resources phase.
    objects.PBXShellScriptBuildPhase[uuid].alwaysOutOfDate = 1;
    return cfg;
  });
}

module.exports = (config) => withActoolPhase(withAsset(config));
