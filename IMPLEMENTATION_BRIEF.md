# Implementation Brief

This file records the project requirements history and the currently authorized work.

## Part 1 — Independent Claude Code Review (completed)

Review-only, read-only. Completed successfully; no project files were changed. Findings are recorded in Part 2 and are the basis for the current remediation round.

Original review scope: browser architecture, note CRUD, local persistence, encryption and passphrase handling, locator derivation, merge and tombstone behavior, CloudFront/S3 design, CloudFormation security, test coverage, accessibility, performance and extensibility.

Review boundary enforced: no application edits, no dependency changes, no deployment, no AWS changes, no commits, no pushes, no network writes. Findings had to cite exact files, symbols and resources.

Verified baseline at review time:

- `npm test`: 13 tests passed.
- Mocked two-browser encrypted sync passed.
- Live CloudFront two-browser sync passed.
- Direct S3 access returned HTTP 403.
- CloudFormation stack `UPDATE_COMPLETE`.

Claude Code review result: session `39c6ab86-5605-4a01-9eb3-61a7fe76e3c8`, subtype `success`, 18 turns, cost $1.3359192, reviewed commit `35da767`.

## Part 2 — Accepted review findings to remediate

### Critical

R1. `/sync/*` is an unauthenticated same-origin upload endpoint. Arbitrary content types can be stored and served from the application origin, and the shared CSP allows `script-src 'self'`. Evidence: `infra/template.yaml` `NotesRequestValidator`, `NotesOriginRequestPolicy`, `NotesBucketPolicy`, and the shared `SiteResponseHeadersPolicy` used by the `/sync/*` cache behavior.

### High

R2. Typing during synchronization causes silent data loss. Evidence: `web/app.js` `syncWithCloud()`, `renderEditor()`, `queueSave()`, `flushSave()`.

R3. Multiple tabs overwrite one another. Evidence: `web/app.js` `persist()` writes the whole in-memory array; no `storage` listener, `BroadcastChannel`, or lock.

R4. Sync locator derivation bypasses expensive password derivation. Evidence: `web/sync-crypto.js` `deriveSyncLocator()` is a single unsalted SHA-256 over the passphrase; measured roughly 1,250× faster to guess than the PBKDF2 encryption path.

R5. Cloud writes have no conflict protection. Evidence: `web/app.js` `writeRemote()` sends unconditional `PUT`.

R6. Same-note conflicts silently discard one edit and clock skew can bias the winner. Evidence: `web/sync-crypto.js` `mergeSyncStates()` compares client `updatedAt` values.

R7. Mobile delete is unavailable. Evidence: `web/styles.css` sets `.danger-button { display: none; }` in the `max-width: 760px` media query with no alternative control.

### Other accepted items

- Importing a previously deleted note is blocked by its tombstone while still reporting success.
- A mistyped passphrase silently creates a different empty notebook.
- HTTP 403 is treated as "not found", masking permission failures.
- Invalid timestamps can win merges.
- Tombstones are never purged.
- Search input lacks an accessible name; import is not keyboard accessible; mobile sidebar lacks Escape handling, `inert`, and correct expanded state.
- Secondary text contrast fails WCAG AA.
- No "disconnect and erase this device" workflow.
- `e2e/live-sync.mjs` prints the capability-bearing locator and defaults to the production URL.
- `web/app.js` mixes UI, persistence, timers, sync and networking, which makes behavior hard to test.

## Part 3 — Current authorized work: remediation round 1

### Objective

Fix the security, data-integrity and accessibility defects above with regression tests, then produce a version eligible for GitHub publication.

### Must fix in this round

1. R1 security boundary. Delivered through CloudFront-layer controls only; no new AWS service or execution role may be introduced, because the `agent-dev` identity cannot create IAM roles or Lambda functions.
2. R2 data loss while typing during sync.
3. R3 cross-tab overwrite.
4. R5 conditional cloud writes using S3 `ETag` with `If-Match`.
5. R6 explicit same-note conflict handling that never silently discards an edit.
6. R7 mobile delete.
7. 403 versus 404 handling.
8. Import of a previously deleted note must be honest about the tombstone.
9. Wrong-passphrase detection must not silently open a different empty notebook.
10. Invalid timestamps must not win merges.
11. Accessibility items: search accessible name, keyboard-operable import, mobile sidebar Escape/`inert`/expanded state, WCAG AA contrast for secondary text.
12. `e2e/live-sync.mjs` must not print the object locator and must require an explicit `APP_URL` instead of defaulting to production.

### Deferred to round 2, with rationale

- R4 crypto format v2. This changes the locator and envelope format, so it must ship as a versioned migration with frozen v1 fixtures rather than inside this round. Any change must keep existing deployed notebooks readable and must not orphan current cloud data.
- Tombstone garbage collection and the encrypted-notebook size ceiling. Both need a capacity and retention design decision.
- "Disconnect and erase this device". Needs a UX decision about what gets removed and when.
- Splitting `web/app.js` into modules. Structural refactor; do it as its own reviewed change.

### Constraints

- Keep the browser talking only to the CloudFront domain.
- Never embed AWS credentials in the browser.
- The notes bucket must stay private; direct S3 access must keep returning 403.
- Do not weaken CSP for `/`; harden `/sync/*` specifically.
- The passphrase must never be transmitted.
- Changes must remain backward compatible with notebooks already stored in the deployed notes bucket.
- Do not change the cryptographic envelope format in this round.
- Do not deploy, do not modify AWS, do not commit, and do not push. Eve handles those after independent verification.

### Required tests

- CloudFront function validation tests for content type, path, method and size.
- Response headers policy tests proving `/sync/*` responses cannot execute as script and are not cached.
- Unit tests for merge behavior with invalid, missing and equal timestamps.
- Unit tests proving a conflicting same-note edit is preserved rather than discarded.
- Browser tests reproducing and then preventing typing-during-sync loss.
- Browser tests for cross-tab edits.
- Browser tests for conditional-write conflict retry.
- Mobile viewport test proving delete is reachable and remains accessible.
- Accessibility checks for the search name, import control and sidebar state.

### Acceptance criteria

1. `npm test` passes with the new tests included, and existing tests are not deleted to make the suite pass.
2. `npm run test:e2e` and `npm run test:sync` pass against a local server.
3. A new test proves `/sync/*` cannot serve script-executable or non-JSON content, and that `/sync/*` responses are not cached at the edge.
4. A new test proves typing during an in-flight sync does not lose or revert user input.
5. A new test proves two tabs converge without one silently discarding the other's note.
6. A new test proves a conflicting same-note edit results in a preserved conflict rather than silent loss.
7. A new test proves a conditional write conflict is retried after refetch and merge.
8. A new test proves delete is reachable at a mobile viewport.
9. `npm run validate:infra` succeeds.
10. The diff contains no credentials, tokens, passphrases or personal note content.

### Deliverable

Updated source, tests, infrastructure template and documentation describing the hardened `/sync/*` boundary and the conflict behavior, ready for Eve's independent verification, a fresh security review, and GitHub publication.
