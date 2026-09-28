import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceSyncBase,
  CONFLICT_SUFFIX,
  createPassphraseVerifier,
  createSyncBase,
  deriveSyncLocator,
  importIntoState,
  matchesPassphraseVerifier,
  mergeSyncStates,
} from '../web/sync-crypto.js';

const note = (id, updatedAt, title = id, content = `${title} content`) => ({
  id,
  title,
  content,
  createdAt: '2026-09-28T00:00:00.000Z',
  updatedAt,
});
const state = (notes, tombstones = []) => ({ notes, tombstones });

// ---- invalid, missing and equal timestamps ----

test('an unparseable updatedAt never wins against a valid timestamp', () => {
  const valid = note('a', '2026-09-28T01:00:00.000Z', 'Valid');
  const invalid = note('a', 'not-a-date', 'Invalid');
  assert.equal(mergeSyncStates(state([valid]), state([invalid])).notes[0].title, 'Valid');
  assert.equal(mergeSyncStates(state([invalid]), state([valid])).notes[0].title, 'Valid');
});

test('an empty updatedAt never wins against a valid timestamp', () => {
  const valid = note('a', '2026-09-28T01:00:00.000Z', 'Valid');
  const empty = note('a', '', 'Empty');
  assert.equal(mergeSyncStates(state([empty]), state([valid])).notes[0].title, 'Valid');
  assert.equal(mergeSyncStates(state([valid]), state([empty])).notes[0].title, 'Valid');
});

test('a note with a missing updatedAt cannot override a valid note', () => {
  const valid = note('a', '2026-09-28T01:00:00.000Z', 'Valid');
  const { updatedAt, ...missing } = note('a', 'x', 'Missing');
  const merged = mergeSyncStates(state([missing]), state([valid]));
  assert.deepEqual(merged.notes.map((item) => item.title), ['Valid']);
});

test('equal timestamps resolve deterministically regardless of argument order', () => {
  const left = note('a', '2026-09-28T01:00:00.000Z', 'Alpha');
  const right = note('a', '2026-09-28T01:00:00.000Z', 'Bravo');
  const forward = mergeSyncStates(state([left]), state([right]));
  const reverse = mergeSyncStates(state([right]), state([left]));
  assert.deepEqual(forward.notes, reverse.notes);
  assert.equal(forward.notes.length, 1);
});

test('equivalent timestamp spellings compare as equal instants and still resolve deterministically', () => {
  const left = note('a', '2026-09-28T01:00:00Z', 'Alpha');
  const right = note('a', '2026-09-28T01:00:00.000Z', 'Bravo');
  assert.deepEqual(
    mergeSyncStates(state([left]), state([right])).notes,
    mergeSyncStates(state([right]), state([left])).notes,
  );
});

test('two invalid timestamps still resolve deterministically', () => {
  const left = note('a', 'garbage', 'Alpha');
  const right = note('a', '', 'Bravo');
  assert.deepEqual(
    mergeSyncStates(state([left]), state([right])).notes,
    mergeSyncStates(state([right]), state([left])).notes,
  );
});

test('a tombstone with an invalid deletedAt never deletes a note', () => {
  const kept = note('a', '2026-09-28T01:00:00.000Z');
  for (const deletedAt of ['', 'not-a-date']) {
    const merged = mergeSyncStates(state([kept]), state([], [{ id: 'a', deletedAt }]));
    assert.deepEqual(merged.notes.map((item) => item.id), ['a']);
    assert.deepEqual(merged.tombstones, []);
  }
});

test('a valid tombstone beats a note whose timestamp is invalid', () => {
  const merged = mergeSyncStates(
    state([note('a', 'not-a-date')]),
    state([], [{ id: 'a', deletedAt: '2026-09-28T01:00:00.000Z' }]),
  );
  assert.deepEqual(merged.notes, []);
});

test('equal deletion and edit timestamps resolve the same way in either order', () => {
  const edit = state([note('a', '2026-09-28T01:00:00.000Z')]);
  const deletion = state([], [{ id: 'a', deletedAt: '2026-09-28T01:00:00.000Z' }]);
  assert.deepEqual(mergeSyncStates(edit, deletion), mergeSyncStates(deletion, edit));
});

// ---- three-way merge and conflict preservation ----

test('without base information the existing newest-wins behaviour is unchanged', () => {
  const merged = mergeSyncStates(
    state([note('shared', '2026-09-28T01:00:00.000Z', 'Local')]),
    state([note('shared', '2026-09-28T03:00:00.000Z', 'Remote')]),
  );
  assert.deepEqual(merged.notes.map((item) => item.title), ['Remote']);
  assert.deepEqual(merged.conflicts, []);
});

test('a conflicting same-note edit is preserved as a labelled copy instead of being discarded', () => {
  const original = note('shared', '2026-09-28T01:00:00.000Z', 'Plan', 'Original text');
  const base = createSyncBase(state([original]));
  const local = { ...original, content: 'Local edit', updatedAt: '2026-09-28T02:00:00.000Z' };
  const remote = { ...original, content: 'Remote edit', updatedAt: '2026-09-28T03:00:00.000Z' };
  const merged = mergeSyncStates(state([local]), state([remote]), { base });

  const byContent = Object.fromEntries(merged.notes.map((item) => [item.content, item]));
  assert.ok(byContent['Remote edit'], 'newer edit kept');
  assert.ok(byContent['Local edit'], 'older edit preserved');
  assert.equal(byContent['Remote edit'].id, 'shared');
  assert.notEqual(byContent['Local edit'].id, 'shared');
  assert.equal(byContent['Local edit'].title, `Plan${CONFLICT_SUFFIX}`);
  assert.equal(byContent['Local edit'].conflictOf, 'shared');
  assert.equal(merged.conflicts.length, 1);
  assert.deepEqual(
    { id: merged.conflicts[0].id, kept: merged.conflicts[0].kept, copied: merged.conflicts[0].copied },
    { id: 'shared', kept: 'remote', copied: 'local' },
  );
});

test('conflict copies are deterministic for identical inputs', () => {
  const original = note('shared', '2026-09-28T01:00:00.000Z', 'Plan', 'Original');
  const base = createSyncBase(state([original]));
  const local = state([{ ...original, content: 'Mine', updatedAt: '2026-09-28T02:00:00.000Z' }]);
  const remote = state([{ ...original, content: 'Theirs', updatedAt: '2026-09-28T02:00:00.000Z' }]);
  const first = mergeSyncStates(local, remote, { base });
  const second = mergeSyncStates(local, remote, { base });
  const swapped = mergeSyncStates(remote, local, { base });
  assert.deepEqual(first, second);
  assert.deepEqual(first.notes, swapped.notes);
});

test('re-merging an already preserved conflict does not duplicate the copy or re-report it', () => {
  const original = note('shared', '2026-09-28T01:00:00.000Z', 'Plan', 'Original');
  const base = createSyncBase(state([original]));
  const remote = state([{ ...original, content: 'Theirs', updatedAt: '2026-09-28T03:00:00.000Z' }]);
  const first = mergeSyncStates(
    state([{ ...original, content: 'Mine', updatedAt: '2026-09-28T02:00:00.000Z' }]),
    remote,
    { base },
  );
  const again = mergeSyncStates(first, remote, { base });
  assert.equal(again.notes.length, 2);
  assert.deepEqual(again.conflicts, []);
});

test('a non-conflicting newer edit simply wins', () => {
  const original = note('shared', '2026-09-28T01:00:00.000Z', 'Plan', 'Original');
  const base = createSyncBase(state([original]));
  const remoteEdit = { ...original, content: 'Remote edit', updatedAt: '2026-09-28T02:00:00.000Z' };
  const merged = mergeSyncStates(state([original]), state([remoteEdit]), { base });
  assert.deepEqual(merged.notes.map((item) => item.content), ['Remote edit']);
  assert.deepEqual(merged.conflicts, []);

  const localEdit = { ...original, content: 'Local edit', updatedAt: '2026-09-28T02:00:00.000Z' };
  const mergedLocal = mergeSyncStates(state([localEdit]), state([original]), { base });
  assert.deepEqual(mergedLocal.notes.map((item) => item.content), ['Local edit']);
  assert.deepEqual(mergedLocal.conflicts, []);
});

test('a one-sided edit is not discarded when the unchanged side has a skewed, later clock', () => {
  const original = note('shared', '2026-09-28T05:00:00.000Z', 'Plan', 'Original');
  const base = createSyncBase(state([original]));
  const edit = { ...original, content: 'Edited on a device with a slow clock', updatedAt: '2026-09-28T04:00:00.000Z' };
  const merged = mergeSyncStates(state([edit]), state([original]), { base });
  assert.deepEqual(merged.notes.map((item) => item.content), ['Edited on a device with a slow clock']);
});

test('a one-sided edit with an older clock is re-stamped so timestamp-only merges keep it', () => {
  const original = note('shared', '2026-09-28T05:00:00.000Z', 'Plan', 'Original');
  const base = createSyncBase(state([original]));
  const edit = { ...original, content: 'Edit from a slow clock', updatedAt: '2026-09-28T04:00:00.000Z' };
  const merged = mergeSyncStates(state([original]), state([edit]), { base });
  const [kept] = merged.notes;
  assert.equal(kept.content, 'Edit from a slow clock');
  assert.equal(kept.updatedAt, '2026-09-28T05:00:00.001Z');
  // Another tab or an older client still holding the original version keeps the edit.
  assert.equal(mergeSyncStates(state([original]), merged).notes[0].content, 'Edit from a slow clock');
  assert.equal(mergeSyncStates(merged, state([original])).notes[0].content, 'Edit from a slow clock');
});

test('a conflicting edit with an invalid timestamp loses but is still preserved', () => {
  const original = note('shared', '2026-09-28T01:00:00.000Z', 'Plan', 'Original');
  const base = createSyncBase(state([original]));
  const broken = { ...original, content: 'Broken clock edit', updatedAt: 'invalid' };
  const valid = { ...original, content: 'Valid edit', updatedAt: '2026-09-28T02:00:00.000Z' };
  const merged = mergeSyncStates(state([broken]), state([valid]), { base });
  const winner = merged.notes.find((item) => item.id === 'shared');
  assert.equal(winner.content, 'Valid edit');
  assert.ok(merged.notes.some((item) => item.content === 'Broken clock edit' && item.id !== 'shared'));
});

test('advanceSyncBase records versions both sides now share', () => {
  const original = note('a', '2026-09-28T01:00:00.000Z', 'A', 'v1');
  const remoteEdit = { ...original, content: 'v2', updatedAt: '2026-09-28T02:00:00.000Z' };
  const base = createSyncBase(state([original]));
  const merged = mergeSyncStates(state([original]), state([remoteEdit]), { base });
  const advanced = advanceSyncBase(base, merged, state([remoteEdit]));
  assert.deepEqual(advanced, createSyncBase(state([remoteEdit])));
  // A later remote edit now counts as one-sided, so it wins without a spurious conflict.
  const later = { ...original, content: 'v3', updatedAt: '2026-09-28T03:00:00.000Z' };
  const next = mergeSyncStates(merged, state([later]), { base: advanced });
  assert.deepEqual(next.notes.map((item) => item.content), ['v3']);
  assert.deepEqual(next.conflicts, []);
});

// ---- honest import of previously deleted notes ----

test('importing a previously deleted note restores it and reports the count', () => {
  const now = '2026-09-28T09:00:00.000Z';
  const current = state([note('kept', '2026-09-28T01:00:00.000Z')], [{ id: 'gone', deletedAt: '2026-09-28T05:00:00.000Z' }]);
  const result = importIntoState(current, [note('gone', '2026-09-28T02:00:00.000Z', 'Gone'), note('fresh', '2026-09-28T03:00:00.000Z')], { now });
  assert.equal(result.restored, 1);
  assert.equal(result.added, 1);
  assert.equal(result.total, 2);
  const restored = result.state.notes.find((item) => item.id === 'gone');
  assert.ok(restored, 'deleted note restored by explicit import');
  assert.equal(restored.updatedAt, now);
  assert.deepEqual(result.state.tombstones, []);
  // The restored version must also win against the tombstone when merged with another device.
  const remote = state([], [{ id: 'gone', deletedAt: '2026-09-28T05:00:00.000Z' }]);
  assert.ok(mergeSyncStates(result.state, remote).notes.some((item) => item.id === 'gone'));
});

test('import reports notes whose newer local version was kept', () => {
  const current = state([note('a', '2026-09-28T05:00:00.000Z', 'Newer local')]);
  const result = importIntoState(current, [note('a', '2026-09-28T01:00:00.000Z', 'Older import')]);
  assert.deepEqual({ added: result.added, updated: result.updated, restored: result.restored, unchanged: result.unchanged }, {
    added: 0,
    updated: 0,
    restored: 0,
    unchanged: 1,
  });
  assert.equal(result.state.notes[0].title, 'Newer local');
});

// ---- local passphrase verifier ----

test('passphrase verifier matches only the passphrase it was created from and stores no passphrase', async () => {
  const passphrase = 'placeholder passphrase one';
  const verifier = await createPassphraseVerifier(passphrase);
  assert.ok(!JSON.stringify(verifier).includes('placeholder'));
  assert.equal(verifier.locator, await deriveSyncLocator(passphrase));
  assert.equal(await matchesPassphraseVerifier(verifier, passphrase), true);
  assert.equal(await matchesPassphraseVerifier(verifier, 'placeholder passphrase two'), false);
  assert.equal(await matchesPassphraseVerifier(null, passphrase), false);
});
