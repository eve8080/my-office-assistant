# My Office Assistant

A lightweight office notebook deployed on AWS CloudFront. Version 0.1 focuses on fast note taking through a clean web interface.

## Live application

https://dxwxnajdv6k2s.cloudfront.net

## Current features

- Create, edit, search and delete notes
- Automatic local saving
- Note count, update timestamp and word count
- JSON export and import
- Desktop and mobile responsive layouts
- Keyboard shortcuts:
  - `Cmd/Ctrl + N` — new note
  - `Cmd/Ctrl + S` — save immediately

## Data and privacy

Version 0.1 stores notes in browser `localStorage`. Note content is **not uploaded to AWS** and never reaches the S3 bucket or CloudFront logs. This keeps the initial version simple and avoids exposing an unauthenticated notes API.

Consequences:

- Notes are available only in the browser/profile where they were created.
- Clearing browser data removes local notes.
- Use **Export** to create a backup and **Import** to restore or move notes.

Before cross-device sync or shared notes are added, the project should introduce authentication and encrypted server-side storage behind the existing CloudFront domain.

## Architecture

```text
Browser
  ├─ Static UI from CloudFront
  └─ Notes in localStorage

CloudFront (HTTPS + security headers)
  └─ Private S3 bucket through Origin Access Control
```

The S3 bucket blocks public access. Only the CloudFront distribution can read site files.

## Project structure

```text
web/                  Static web application
  index.html
  styles.css
  app.js
  note-store.js
infra/template.yaml   AWS CloudFormation infrastructure
scripts/deploy.sh     Validate, deploy, upload and invalidate CloudFront
test/                 Unit tests
e2e/run.mjs           Browser end-to-end smoke test
artifacts/             QA screenshots
```

## Development

Start a local server:

```bash
python3 -m http.server 4173 --bind 127.0.0.1 --directory web
```

Then open `http://127.0.0.1:4173`.

Run unit tests:

```bash
npm test
```

Run the browser test while the local server is running:

```bash
npm run test:e2e
```

## AWS deployment

The deployment uses the `agent-dev` AWS profile and defaults to `ap-southeast-1`.

```bash
npm run validate:infra
npm run deploy
```

The deploy script:

1. Validates the CloudFormation template.
2. Creates or updates the private S3 bucket and CloudFront distribution.
3. Uploads the static application.
4. Creates and waits for a CloudFront cache invalidation.
5. Writes deployment identifiers to the ignored `.aws-output.json` file.

## Planned extension path

Additional functions can be added without changing the public domain:

1. Add user authentication, preferably through the company-approved identity provider.
2. Add a serverless API as a second CloudFront origin.
3. Store encrypted notes in DynamoDB or another approved data store.
4. Add meeting templates, action tracking, search and office workflows as separate modules.

Do not add a public notes API without authentication and explicit data-retention controls.
