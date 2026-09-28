import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decryptSyncState,
  deriveSyncLocator,
  encryptSyncState,
  mergeSyncStates,
} from '../web/sync-crypto.js';

const note = (id, updatedAt, title = id) => ({
  id,
  title,
  content: `${title} content`,
  createdAt: updatedAt,
  updatedAt,
});

test('mergeSyncStates keeps the newest version of each note', () => {
  const local = {
    notes: [note('shared', '2026-09-28T01:00:00.000Z', 'Local'), note('local', '2026-09-28T02:00:00.000Z')],
    tombstones: [],
  };
  const remote = {
    notes: [note('shared', '2026-09-28T03:00:00.000Z', 'Remote'), note('remote', '2026-09-28T02:30:00.000Z')],
    tombstones: [],
  };
  const merged = mergeSyncStates(local, remote);
  assert.deepEqual(merged.notes.map((item) => item.id), ['shared', 'remote', 'local']);
  assert.equal(merged.notes[0].title, 'Remote');
});

test('mergeSyncStates applies newer deletion tombstones', () => {
  const local = {
    notes: [note('keep', '2026-09-28T03:00:00.000Z'), note('delete-me', '2026-09-28T01:00:00.000Z')],
    tombstones: [{ id: 'delete-me', deletedAt: '2026-09-28T02:00:00.000Z' }],
  };
  const remote = {
    notes: [note('delete-me', '2026-09-28T01:30:00.000Z')],
    tombstones: [],
  };
  const merged = mergeSyncStates(local, remote);
  assert.deepEqual(merged.notes.map((item) => item.id), ['keep']);
  assert.deepEqual(merged.tombstones, [{ id: 'delete-me', deletedAt: '2026-09-28T02:00:00.000Z' }]);
});

test('a newer note restores an older deletion', () => {
  const merged = mergeSyncStates(
    { notes: [], tombstones: [{ id: 'restored', deletedAt: '2026-09-28T01:00:00.000Z' }] },
    { notes: [note('restored', '2026-09-28T02:00:00.000Z')], tombstones: [] },
  );
  assert.deepEqual(merged.notes.map((item) => item.id), ['restored']);
  assert.deepEqual(merged.tombstones, []);
});

test('encryptSyncState round-trips without exposing plaintext', async () => {
  const state = { notes: [note('private', '2026-09-28T03:00:00.000Z', 'Confidential')], tombstones: [] };
  const payload = await encryptSyncState(state, 'correct horse battery staple');
  assert.equal(payload.version, 1);
  assert.ok(!JSON.stringify(payload).includes('Confidential'));
  assert.deepEqual(await decryptSyncState(payload, 'correct horse battery staple'), state);
  await assert.rejects(() => decryptSyncState(payload, 'wrong passphrase'));
});

test('deriveSyncLocator is deterministic and does not expose the passphrase', async () => {
  const first = await deriveSyncLocator('correct horse battery staple');
  const second = await deriveSyncLocator('correct horse battery staple');
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.ok(!first.includes('correct'));
});
