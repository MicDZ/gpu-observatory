# Contributing

Use Node.js 20+ and Python 3.10+. The hub and frontend have no npm runtime dependencies. Install Python dependencies in a virtual environment, then run:

```sh
npm test
python -m unittest discover -s tests -p 'test_*.py'
npm run demo
```

Keep Chinese and English text in sync in `public/i18n.js`. Use `textContent` for reported strings. Preserve source-bound credentials, HTTPS verification, bounded collection, stale-state handling and the private-data cache policy. New tests and screenshots must use fictional identities and data. Do not attach real deployment configs or telemetry to pull requests.

Configuration changes require a hub restart. Static production assets are loaded at startup. UI preview changes can be checked using the local synthetic demo. Before publishing, inspect `git diff --cached`, filenames, image contents, URLs and generated artifacts for personal data or secrets.

The app icon is original geometric artwork. Edit `deploy/build-icons.mjs` and run `npm run build:icons` to regenerate the SVG and all PNG variants together. Keep the mark inside the maskable safe circle. Update icon URL revisions and the public service-worker cache version when changing the artwork.
