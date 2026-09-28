function isValidNote(note) {
  return Boolean(
    note &&
      typeof note === 'object' &&
      typeof note.id === 'string' &&
      typeof note.title === 'string' &&
      typeof note.content === 'string' &&
      typeof note.createdAt === 'string' &&
      typeof note.updatedAt === 'string',
  );
}

function sortNewest(notes) {
  return [...notes].sort((a, b) => {
    const byUpdated = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    return byUpdated || a.id.localeCompare(b.id);
  });
}

export function createNote({ id = crypto.randomUUID(), now = new Date().toISOString() } = {}) {
  return {
    id,
    title: '',
    content: '',
    createdAt: now,
    updatedAt: now,
  };
}

export function normalizeNotes(value) {
  if (!Array.isArray(value)) return [];
  return sortNewest(value.filter(isValidNote));
}

export function upsertNote(notes, note) {
  if (!isValidNote(note)) throw new TypeError('Invalid note');
  return sortNewest([...normalizeNotes(notes).filter((item) => item.id !== note.id), note]);
}

export function deleteNote(notes, id) {
  return normalizeNotes(notes).filter((note) => note.id !== id);
}

export function filterNotes(notes, query) {
  const normalized = String(query ?? '').trim().toLocaleLowerCase();
  const allNotes = normalizeNotes(notes);
  if (!normalized) return allNotes;
  return allNotes.filter((note) =>
    `${note.title}\n${note.content}`.toLocaleLowerCase().includes(normalized),
  );
}
