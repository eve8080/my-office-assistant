import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNote,
  deleteNote,
  filterNotes,
  normalizeNotes,
  upsertNote,
} from '../web/note-store.js';

test('createNote creates a blank timestamped note', () => {
  const note = createNote({ id: 'note-1', now: '2026-09-28T02:00:00.000Z' });
  assert.deepEqual(note, {
    id: 'note-1',
    title: '',
    content: '',
    createdAt: '2026-09-28T02:00:00.000Z',
    updatedAt: '2026-09-28T02:00:00.000Z',
  });
});

test('upsertNote replaces a note and sorts newest first', () => {
  const notes = [
    createNote({ id: 'older', now: '2026-09-28T01:00:00.000Z' }),
    createNote({ id: 'newer', now: '2026-09-28T02:00:00.000Z' }),
  ];
  const updated = { ...notes[0], title: 'Updated', updatedAt: '2026-09-28T03:00:00.000Z' };
  assert.deepEqual(upsertNote(notes, updated).map((note) => note.id), ['older', 'newer']);
  assert.equal(upsertNote(notes, updated)[0].title, 'Updated');
});

test('deleteNote removes only the selected note', () => {
  const notes = [
    createNote({ id: 'a', now: '2026-09-28T01:00:00.000Z' }),
    createNote({ id: 'b', now: '2026-09-28T02:00:00.000Z' }),
  ];
  assert.deepEqual(deleteNote(notes, 'a').map((note) => note.id), ['b']);
});

test('filterNotes searches title and content case-insensitively', () => {
  const notes = [
    { ...createNote({ id: 'a', now: '2026-09-28T01:00:00.000Z' }), title: 'Peter meeting' },
    { ...createNote({ id: 'b', now: '2026-09-28T02:00:00.000Z' }), content: 'Follow up with Lucas' },
  ];
  assert.deepEqual(filterNotes(notes, 'peter').map((note) => note.id), ['a']);
  assert.deepEqual(filterNotes(notes, 'LUCAS').map((note) => note.id), ['b']);
  assert.equal(filterNotes(notes, '').length, 2);
});

test('normalizeNotes rejects malformed storage and keeps valid notes', () => {
  const valid = createNote({ id: 'a', now: '2026-09-28T01:00:00.000Z' });
  assert.deepEqual(normalizeNotes([valid, null, { title: 'missing id' }]), [valid]);
  assert.deepEqual(normalizeNotes('not-an-array'), []);
});
