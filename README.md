# My Office Assistant

A lightweight office notebook deployed on AWS CloudFront. The first release focuses on fast note taking with encrypted synchronization across computers.

## Live application

https://dxwxnajdv6k2s.cloudfront.net

## Current features

- Create, edit, search and delete notes
- Automatic local saving and encrypted cloud synchronization
- Merge changes made on different computers and in several tabs of the same browser
- Keep both versions when the same note is edited in two places at once
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

To catch typing mistakes, each browser remembers a local verifier for the passphrase last used on it: a salted PBKDF2 hash plus the notebook locator it opens. The verifier never contains the passphrase and is never uploaded. If a passphrase does not match the verifier **and** no cloud notebook exists for it, the app warns that this is probably a typo and only creates a new, separate notebook after you select **Create new notebook**. If a notebook exists but cannot be decrypted, the app reports "Unable to unlock the cloud notebook".

## Data and privacy

Notes remain in browser `localStorage` for fast local operation and are also synchronized as one encrypted payload in a dedicated private S3 bucket.

Before leaving the browser:

- The notebook is encrypted with AES-256-GCM.
- The encryption key is derived from the passphrase with PBKDF2-SHA-256 and 250,000 iterations.
- The S3 object locator is derived separately from the passphrase.
- Note titles and content do not appear in the S3 object as plaintext.

AWS receives only the encrypted payload, encryption salt, initialization vector and update timestamp. S3 server-side AES-256 encryption and versioning provide an additional storage layer. Non-current object versions expire after 30 days.

Direct public S3 access is blocked. CloudFront Origin Access Control signs reads and writes to the notes bucket. The bucket policy has two statements, each limited to the CloudFront service principal and conditioned on this distribution (`AWS:SourceArn`):

- `s3:GetObject` and `s3:PutObject` on `sync/notebooks/*` only.
- `s3:ListBucket` on the bucket itself. S3 returns `403` instead of `404` for an object that does not exist unless the caller also has `s3:ListBucket`. This grant makes a notebook that does not exist yet return `404`, so `403` keeps meaning a real access problem. It cannot be used to list anything:
  - the CloudFront Function only accepts `/sync/notebooks/<64 hex>.json`;
  - the origin request policy forwards no query strings.

  No `s3:prefix` condition is attached, because S3 evaluates this permission for `GetObject` requests, where that key does not exist.

### Hardened `/sync/*` boundary

The `/sync/*` route is protected with CloudFront-layer controls only. No Lambda, IAM role, API Gateway or other new AWS service is used.

- **Viewer-request CloudFront Function (`NotesRequestValidator`)**
  - Only `/sync/notebooks/<64 lowercase hex>.json` is accepted. Any other path gets `400`.
  - Only `GET`, `HEAD`, `OPTIONS` and `PUT` are accepted. `POST`, `PATCH` and `DELETE` get `405` before any origin request. CloudFront only offers method sets where `PUT` comes with all seven methods, so the function is what enforces this.
  - A `PUT` larger than 786,432 bytes gets `413`.
  - A `PUT` must send exactly one `Content-Type` header whose value, trimmed and lower-cased, is `application/json`. Anything else, or no content type at all, gets `415`. Reads need no content type.
- **Dedicated response headers policy (`NotesResponseHeadersPolicy`)**, used only by `/sync/*`
  - `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox`
  - `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and HSTS.
  - `Cache-Control: no-store, max-age=0`.
  - Together, these keep a stored object from executing as script or rendering as a document, even if it was uploaded before these rules existed.
- **No edge caching.** The behaviour uses the managed `CachingDisabled` cache policy.
- **Conditional writes.** The origin request policy forwards `Content-Type`, `If-Match` and `If-None-Match` so that S3 can enforce them.
- **Site policy unchanged.** The site's own CSP and headers policy for `/` are unchanged.

## Synchronization behavior

- Notes are merged by note ID. Each browser keeps a local *sync base*: a fingerprint of every note as it was at the last successful sync. The base is stored in `localStorage` and never inside the encrypted envelope.
- **Only one side changed a note since the base.** That edit wins. This is the normal path, and it does not depend on clocks agreeing between computers.
- **Both sides changed the same note to different text.** The newer version keeps the note. The other version is kept as a separate note titled `… (conflict copy)`, and a notice explains what happened. No text is discarded. Conflict copies are deterministic, so the same conflict never creates duplicate copies.
- **No base for a note** (for example the first sync after upgrading). The newest `updatedAt` wins, as before.
- A missing, empty or unparseable timestamp never wins against a valid one. A tombstone with an invalid deletion time is ignored. Equal timestamps resolve deterministically.
- Deletions create synchronization tombstones so deleted notes do not return from another computer.
- **Conditional cloud writes.** The app remembers the `ETag` from its read and writes with `If-Match: <etag>`. It creates a new notebook with `If-None-Match: *`.
  - If another computer wrote in between, S3 answers `412`. The app then re-reads, decrypts, merges and retries with the fresh `ETag`, up to three attempts, and reports the retry.
  - If every attempt loses the race, sync reports a failure; nothing is overwritten.
  - If an origin ever omitted the `ETag`, the status would read "Synced (no version check)" instead of hiding it.
- **Typing during a sync is safe.** Unsaved keystrokes are captured into the note before the cloud state is merged, so they take part in the merge and are uploaded. A field you are typing in is never overwritten with other text, and the caret is not moved.
- **Tabs of the same browser converge.** Every save re-reads and merges what is stored (read-merge-write) instead of overwriting it. Tabs notify each other with `BroadcastChannel`, or `storage` events where that is unavailable, and apply each other's changes without discarding in-progress typing.
- **403 versus 404 on the notebook read.** `404` means no notebook exists yet: the app creates one with `If-None-Match: *`. With the `s3:ListBucket` grant above, a `403` should mean a real access problem. Correctness does not depend on the order in which the policy and the app are deployed, though: a `403` read is treated as unverified and resolved by evidence, never by assumption.
  - The wrong-passphrase guard applies exactly as for a `404`. Nothing is written without confirmation.
  - Otherwise the app attempts a create-only write (`If-None-Match: *`, never an unconditional `PUT`).
    - **The write succeeds:** the notebook genuinely did not exist, and the status says a new cloud notebook was created.
    - **`412`/`409` from that create:** the notebook exists but cannot be read.
    - **`403` from that create:** writes are denied too.
  - Both rejected cases are reported as access denied, are not retried as a lost race, and write nothing.
  - Other errors are shown as sync errors. Local notes remain usable on every failure path.
- Local notes are retained when cloud sync is temporarily unavailable and synchronize on the next successful attempt.
- The browser communicates only with the CloudFront domain.

## Import behavior

Importing a JSON export merges notes by ID, and the notice reports what happened: how many notes were new, updated, restored or already up to date.

- If an imported note was **deleted earlier** on this device, the import restores it. It gets a fresh timestamp so the restore also wins on other computers, and the notice says how many previously deleted notes were restored.
- If this device already has a **newer version** of an imported note, the newer version is kept and counted as already up to date.

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
  app.js                Editor, local persistence, cross-tab and sync orchestration
  note-store.js         Pure note data operations
  sync-crypto.js        Encryption, three-way conflict merge and import planning
infra/template.yaml     S3, CloudFront, OAC, request validation and response headers
scripts/deploy.sh       Validate, deploy, upload and invalidate CloudFront
test/                   Unit, merge, contrast and infrastructure tests
  cloudfront-function.test.js  Executes the CloudFront Function code from the template
e2e/support.mjs         Shared Playwright helpers and an ETag-aware mock S3 route
e2e/run.mjs             General browser smoke test
e2e/sync.mjs            Two-browser encrypted synchronization test
e2e/typing-sync.mjs     Typing while a sync is in flight
e2e/cross-tab.mjs       Two tabs editing the same local notebook
e2e/conflict-retry.mjs  412 conditional-write retry and conflict copies
e2e/sync-guards.mjs     403/404 resolution and wrong-passphrase guard
e2e/mobile-a11y.mjs     Mobile delete, accessibility and import restore
e2e/live-sync.mjs       Live deployment check (requires APP_URL)
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
npm run test:e2e        # general smoke test
npm run test:sync       # two-browser encrypted sync
npm run test:typing     # typing during an in-flight sync is not lost
npm run test:cross-tab  # two tabs converge
npm run test:conflict   # 412 retry with fresh If-Match; conflict copy preserved
npm run test:guards     # 403 resolved by conditional create; wrong-passphrase guard
npm run test:mobile     # mobile delete and accessibility checks
npm run test:browser    # all of the above in sequence
```

All browser tests default to `http://127.0.0.1:4173`. Set `APP_URL` to test another local address.

The mocked browser tests use an in-memory S3 route that implements `ETag`, `If-Match` and `If-None-Match`. They verify that plaintext note content does not appear in the uploaded payload.

`npm run test:live` runs a two-browser check against a real deployment. It writes a throwaway notebook, so it requires an explicit `APP_URL` and never prints the notebook locator.

## AWS deployment

Deployment uses the `agent-dev` AWS profile and defaults to `ap-southeast-1`.

```bash
npm run validate:infra
npm run deploy
```

**Not yet verified against the live stack.** The following are part of post-deployment verification:

- **Missing notebooks read as 404.** The currently deployed stack answers `403` for them; after this template is deployed they should answer `404` through CloudFront.
- **Direct S3 access is still blocked.** Direct requests to the bucket should still return `403`.
- **S3 honours the conditional writes.** CloudFront should forward `If-Match` and `If-None-Match`, and S3 should reject a mismatched write with `412`.
- **First-run creation works on both stacks.** Before the policy update, the app's create-only resolution of an ambiguous `403` should still create a new notebook.

The deploy script:

1. Validates the CloudFormation template.
2. Creates or updates the private static-site and encrypted-notes S3 buckets.
3. Configures CloudFront routing, request validation and signed S3 access.
4. Uploads the static application.
5. Creates and waits for a CloudFront cache invalidation.
6. Writes deployment identifiers to the ignored `.aws-output.json` file.

## Planned extension path

Future office-assistant modules can continue using the same CloudFront domain. Features requiring identity, sharing, server-side search or business logic should add company-approved authentication and a separate serverless API origin rather than weakening the encrypted notebook route.
