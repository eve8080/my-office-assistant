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

// Missing, empty or unparseable timestamps sort as older than every valid timestamp.
export function timestampValue(value) {
  if (typeof value !== 'string' || !value.trim()) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

export function compareTimestamps(a, b) {
  const left = timestampValue(a);
  const right = timestampValue(b);
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

// A timestamp for a new version that is always later than the version it replaces,
// even when that version came from a device whose clock runs ahead.
export function nextTimestamp(previous, now = Date.now()) {
  return new Date(Math.max(now, timestampValue(previous) + 1)).toISOString();
}

function sortNewest(notes) {
  return [...notes].sort((a, b) => compareTimestamps(b.updatedAt, a.updatedAt) || a.id.localeCompare(b.id));
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
