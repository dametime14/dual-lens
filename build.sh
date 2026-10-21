#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
APP="$PWD/dist/Dual Lens.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" build/module-cache
cp -R web "$APP/Contents/Resources/"
mkdir -p "$APP/Contents/Resources/src"
for source in backend.mjs controller.mjs context.mjs library.mjs models.mjs providers.mjs quota.mjs claude-usage.py; do
  cp "src/$source" "$APP/Contents/Resources/src/"
done
rm -f "$APP/Contents/Resources/src/proof.mjs" "$APP/Contents/Resources/src/smoke-v2.mjs"
/usr/bin/swiftc -swift-version 5 -O -module-cache-path "$PWD/build/module-cache" -framework Cocoa -framework WebKit src/App.swift -o "$APP/Contents/MacOS/DualLens"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>DualLens</string>
<key>CFBundleIdentifier</key><string>local.duallens.desktop</string>
<key>CFBundleName</key><string>Dual Lens</string>
<key>CFBundleDisplayName</key><string>Dual Lens</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.7</string>
<key>CFBundleVersion</key><string>9</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSHumanReadableCopyright</key><string>Personal local application</string>
</dict></plist>
PLIST
/usr/bin/swiftc -O -module-cache-path "$PWD/build/module-cache" -framework PDFKit src/ExtractPDF.swift -o "$APP/Contents/Resources/extract-pdf"
/usr/bin/swiftc -module-cache-path "$PWD/build/module-cache" src/Icon.swift -o build/make-icon
build/make-icon "$PWD/build/AppIcon.iconset"
/usr/bin/iconutil -c icns "$PWD/build/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"
/usr/libexec/PlistBuddy -c 'Add :CFBundleIconFile string AppIcon' "$APP/Contents/Info.plist"
/usr/bin/codesign --force --deep --sign - "$APP"
printf '%s\n' "$APP"
