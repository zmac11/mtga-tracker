# App icon

Drop your app icon here as `icon.png`:

- **Format:** PNG, square, with a transparent background (no rounded
  corners or drop shadow baked in - macOS/Windows both add their own
  platform-appropriate framing on top of a plain square).
- **Size:** 1024x1024 px. electron-builder generates every smaller size it
  actually needs (down to 16x16 for a Windows taskbar icon) from this one
  file, for both the macOS `.icns` and the Windows `.ico` - you only need
  to provide the single largest version.
- **Design:** keep it simple and high-contrast. It gets displayed as small
  as 16x16px (Windows taskbar) and 32x32px (macOS Dock at a glance), so
  fine detail/thin lines will disappear at that size - a bold, simple
  silhouette or mark reads better than something intricate.

Once `build/icon.png` exists, `npm run dist`/`dist:mac`/`dist:win` will
pick it up automatically (referenced from `package.json`'s `build.icon`)
with no other changes needed.
