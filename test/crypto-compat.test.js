import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decryptSyncState, deriveSyncLocator, mergeSyncStates } from '../web/sync-crypto.js';

// Frozen output of the deployed v1 code (commit 35da767) for a placeholder passphrase.
// Existing cloud notebooks must stay readable at the same locator.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/v1-notebook.json', import.meta.url), 'utf8'));
const passphrase = 'placeholder fixture passphrase v1';

test('v1 notebooks written by the deployed version still decrypt', async () => {
  assert.deepEqual(Object.keys(fixture.envelope).sort(), ['ciphertext', 'iv', 'salt', 'updatedAt', 'version']);
  const state = await decryptSyncState(fixture.envelope, passphrase);
  assert.deepEqual(state.notes.map((note) => note.title), ['Fixture title']);
  assert.deepEqual(state.tombstones, [{ id: 'fixture-deleted', deletedAt: '2026-09-03T00:00:00.000Z' }]);
  assert.deepEqual(mergeSyncStates(state, { notes: [], tombstones: [] }).notes, state.notes);
});

test('the sync locator derivation is unchanged', async () => {
  assert.equal(await deriveSyncLocator(passphrase), fixture.locator);
});
