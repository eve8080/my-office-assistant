# My Office Assistant

## Project purpose
A lightweight, extensible office-assistant web application. The current release provides note creation, editing, search, deletion, JSON import/export, local caching, and client-encrypted synchronization between computers.

## Architecture
- Static browser application in `web/` using plain HTML, CSS and ES modules.
- `web/note-store.js` contains pure note data operations.
- `web/sync-crypto.js` contains state merge, PBKDF2-SHA-256 key derivation and AES-256-GCM encryption/decryption.
- `web/app.js` owns UI state, `localStorage`, tombstones and CloudFront synchronization.
- `infra/template.yaml` creates two private S3 buckets, CloudFront Origin Access Controls, a CloudFront Function and route behaviors.
- `/` serves static assets from the site bucket.
- `/sync/*` reads and writes client-encrypted notebook objects in the notes bucket.
- Deployment uses AWS profile `agent-dev` in `ap-southeast-1`.

## Source of truth
- Functional requirements and operating instructions: `README.md`
- AWS infrastructure: `infra/template.yaml`
- Browser behavior: `web/app.js`
- Cryptography and merge semantics: `web/sync-crypto.js`
- Tests: `test/` and `e2e/`

## Commands
- `npm test` — Node unit and infrastructure tests.
- Start local UI: `python3 -m http.server 4173 --bind 127.0.0.1 --directory web`
- `npm run test:e2e` — general Playwright browser smoke test; requires a local server unless `APP_URL` is supplied.
- `npm run test:sync` — mocked two-browser encrypted synchronization test; requires a local server.
- `npm run validate:infra` — validate the CloudFormation template.
- `npm run deploy` — deploy AWS infrastructure and static assets. Do not run without explicit approval.

## Security boundaries
- Never put AWS credentials, passphrases, tokens or personal note content in source, tests, logs or review output.
- The sync passphrase must never leave the browser.
- AWS stores ciphertext only; direct public S3 access must remain blocked.
- Preserve the CloudFront-only browser access boundary.
- Changes to cryptographic formats require backward-compatibility analysis and tests.

## Working rules
- Use test-driven development for behavior changes.
- Keep notes usable locally when cloud synchronization fails.
- Independently verify desktop/mobile UI, live CloudFront behavior and S3 privacy before deployment claims.
- Do not commit, push, deploy, or change AWS resources unless Mr. So explicitly approves that action.
