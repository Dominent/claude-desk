#!/bin/zsh
# Development only, macOS. `electron .` runs the stock Electron.app bundle, so
# the Dock, the menu bar and the about panel say "Electron", and Launch
# Services ignores a claude:// handler that the bundle does not declare.
# Patch the dev binary once and re-sign it. Packaged builds need none of this.
set -eu
cd "$(dirname "$0")/.."
app=node_modules/electron/dist/Electron.app
plist=$app/Contents/Info.plist
pb=/usr/libexec/PlistBuddy

$pb -c 'Set :CFBundleName Switchboard' "$plist" 2>/dev/null || $pb -c 'Add :CFBundleName string Switchboard' "$plist"
$pb -c 'Set :CFBundleDisplayName Switchboard' "$plist" 2>/dev/null || $pb -c 'Add :CFBundleDisplayName string Switchboard' "$plist"

if ! $pb -c 'Print :CFBundleURLTypes' "$plist" >/dev/null 2>&1; then
  $pb -c 'Add :CFBundleURLTypes array' \
    -c 'Add :CFBundleURLTypes:0 dict' \
    -c 'Add :CFBundleURLTypes:0:CFBundleURLName string "Claude sign-in link"' \
    -c 'Add :CFBundleURLTypes:0:CFBundleURLSchemes array' \
    -c 'Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string claude' "$plist"
fi

cp build/icon.png "$app/Contents/Resources/electron.icns.png" 2>/dev/null || true
codesign -f -s - --deep "$app"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$app"
echo "dev Electron now names itself Switchboard and claims claude://"
