#!/bin/zsh
# Development only. The packaged app declares the claude:// scheme through
# electron-builder; the stock Electron binary does not, and Launch Services
# ignores a handler that does not declare the scheme. Add it and re-sign.
set -eu
plist=node_modules/electron/dist/Electron.app/Contents/Info.plist
if ! /usr/libexec/PlistBuddy -c 'Print :CFBundleURLTypes' "$plist" >/dev/null 2>&1; then
  /usr/libexec/PlistBuddy -c 'Add :CFBundleURLTypes array' \
    -c 'Add :CFBundleURLTypes:0 dict' \
    -c 'Add :CFBundleURLTypes:0:CFBundleURLName string "Claude sign-in link"' \
    -c 'Add :CFBundleURLTypes:0:CFBundleURLSchemes array' \
    -c 'Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string claude' "$plist"
  codesign -f -s - --deep node_modules/electron/dist/Electron.app
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f node_modules/electron/dist/Electron.app
  echo "claude:// declared on the dev Electron binary"
else
  echo "already declared"
fi
