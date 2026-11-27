# Distribution

- Put the .app from `bun run tauri build` at `/Applications/tomarigi-desktop.app`
- Info.plist includes `NSAppleEventsUsageDescription` (the text of the terminal automation permission dialog). The base text is English (`CFBundleDevelopmentRegion` en); the Japanese text is in `src-tauri/locales/ja.lproj/InfoPlist.strings`, copied into the bundle via `bundle.macOS.files` in `tauri.conf.json`
