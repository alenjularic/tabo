# Tabo

A Firefox extension for people who keep hundreds of tabs open.

Tabo sorts your loose tabs into Firefox tab groups labelled by when you last used them, and unloads the ones you have stopped touching so they stop using memory.

```
[ 📌 pinned ]  [ Work ]  [ 🕒 Older ] [ 🕒 2024 ] [ 🕒 June 2026 ] [ 🕒 Last week ] [ 🕒 This week ]  [ new tabs ]
  ignored       yours      oldest ─────────────────────────────────────────────► newest              just opened
```

- **Time groups.** Real Firefox tab groups, so they collapse, sync, and outlive the extension. You choose how deep each level goes — days, weeks, months and years, nought to three of each. Anything older lands in `🕒 Older`.
- **Unloading.** Pick 2 to 30 days and idle tabs get discarded. They stay in the strip; clicking one loads it again.
- **It leaves your tabs alone.** Pinned tabs and tabs already in a group of your own are never touched. Music, calls, screen sharing and the tab you are on are never unloaded.
- **Undo.** Removes Tabo's groups and puts your tabs back in their original order.
- **Backup.** Export every window, group and tab to JSON. Import opens them in new windows, unloaded but correctly titled, so a huge file costs no memory.

Firefox desktop only. Everything runs on your device and nothing is transmitted anywhere.

## Development

```bash
npm test          # 94 tests, node:test, no dependencies
npm run lint      # addons-linter (must be v10+)
npm start         # launch a scratch Firefox with Tabo loaded
npm run build     # package to web-ext-artifacts/
npm run sign      # AMO-signed XPI; needs WEB_EXT_API_KEY and WEB_EXT_API_SECRET
```

Run one file, or one test by name:

```bash
node --test test/planner.test.js
node --test --test-name-pattern 'merge' test/planner.test.js
```

All the decision logic is pure and lives in `src/buckets.js`, `src/planner.js`, `src/unload.js` and `src/portable.js`, which is why the tests need no browser and no mocks. `src/background.js` is the only file that touches `browser.*`.
