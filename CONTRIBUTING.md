# Contributing

## Development Checks

Run the full local check before opening a pull request:

```bash
npm run check
```

Useful focused commands:

```bash
npm test
npm run check:proxy
npm run build:menubar
npm run check:plist
```

## Notes

- Do not commit `menubar-app/.build/` or other generated build output.
- Keep launchd paths portable by editing the templates in `launchd/` and regenerating installed plists with `npm run install:launchd`.
- Keep proxy behavior covered by `node:test` tests when changing request rewriting, session tracking, or status payloads.
