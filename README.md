# My Office Assistant

A lightweight office notebook deployed on AWS CloudFront. The first release focuses on fast note taking with encrypted synchronization across computers.

## Live application

https://dxwxnajdv6k2s.cloudfront.net

## Current features

- Create, edit, search and delete notes
- Automatic local saving and encrypted cloud synchronization
- Merge changes made on different computers
- Synchronize deletions without resurrecting old notes
- Note count, update timestamp and word count
- JSON export and import
- Desktop and mobile responsive layouts
- Keyboard shortcuts:
  - `Cmd/Ctrl + N` — new note
  - `Cmd/Ctrl + S` — save and queue synchronization

## Enabling synchronization

1. Open the application and select **Enable sync**.
2. Enter a strong passphrase of at least 12 characters and confirm it.
3. Enter the exact same passphrase on every other computer.
4. Select **Sync now** whenever an immediate refresh is needed. Edits also synchronize automatically.

The passphrase is not sent to AWS. It is retained only in the browser session so the tab can continue synchronizing. Closing the browser session requires the passphrase to be entered again.

There is no passphrase recovery. A different passphrase opens a different encrypted notebook.

## Data and privacy

Notes remain in browser `localStorage` for fast local operation and are also synchronized as one encrypted payload in a dedicated private S3 bucket.

Before leaving the browser:

- The notebook is encrypted with AES-256-GCM.
- The encryption key is derived from the passphrase with PBKDF2-SHA-256 and 250,000 iterations.
- The S3 object locator is derived separately from the passphrase.
- Note titles and content do not appear in the S3 object as plaintext.

AWS receives only the encrypted payload, encryption salt, initialization vector and update timestamp. S3 server-side AES-256 encryption and versioning provide an additional storage layer. Non-current object versions expire after 30 days.

Direct public S3 access is blocked. CloudFront Origin Access Control signs reads and writes, and a CloudFront Function restricts synchronization requests to fixed notebook paths, approved methods and a maximum payload size.

## Synchronization behavior

- Notes are merged by note ID and `updatedAt` timestamp.
- The newest version of an edited note wins.
- Deletions create synchronization tombstones so deleted notes do not return from another computer.
- Local notes are retained when cloud sync is temporarily unavailable and synchronize on the next successful attempt.
- The browser communicates only with the CloudFront domain.

## Architecture

```text
Browser
  ├─ localStorage cache
  ├─ PBKDF2 key derivation
  └─ AES-256-GCM encryption/decryption
          │
          ▼
CloudFront HTTPS distribution
  ├─ Default route → private static-site S3 bucket
  └─ /sync/* route
       ├─ CloudFront Function path/method validation
       ├─ Origin Access Control request signing
       └─ private versioned notes S3 bucket
```

No AWS credentials or permanent access keys are stored in the browser.

## Project structure

```text
web/                    Static web application
  index.html
  styles.css
  app.js                Editor, local persistence and sync orchestration
  note-store.js         Pure note data operations
  sync-crypto.js        Encryption and conflict-merge operations
infra/template.yaml     S3, CloudFront, OAC and request validation
scripts/deploy.sh       Validate, deploy, upload and invalidate CloudFront
test/                   Unit and infrastructure tests
e2e/run.mjs             General browser smoke test
e2e/sync.mjs            Two-browser encrypted synchronization test
artifacts/               Ignored QA screenshots
```

## Development

Start a local server:

```bash
python3 -m http.server 4173 --bind 127.0.0.1 --directory web
```

Then open `http://127.0.0.1:4173`.

Run unit and infrastructure tests:

```bash
npm test
```

Run browser tests while the local server is running:

```bash
npm run test:e2e
npm run test:sync
```

The sync browser test uses an in-memory mocked S3 route and verifies that plaintext note content does not appear in the uploaded payload.

## AWS deployment

Deployment uses the `agent-dev` AWS profile and defaults to `ap-southeast-1`.

```bash
npm run validate:infra
npm run deploy
```

The deploy script:

1. Validates the CloudFormation template.
2. Creates or updates the private static-site and encrypted-notes S3 buckets.
3. Configures CloudFront routing, request validation and signed S3 access.
4. Uploads the static application.
5. Creates and waits for a CloudFront cache invalidation.
6. Writes deployment identifiers to the ignored `.aws-output.json` file.

## Planned extension path

Future office-assistant modules can continue using the same CloudFront domain. Features requiring identity, sharing, server-side search or business logic should add company-approved authentication and a separate serverless API origin rather than weakening the encrypted notebook route.
