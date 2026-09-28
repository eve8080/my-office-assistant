import { compareTimestamps, nextTimestamp, normalizeNotes, timestampValue } from './note-store.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ITERATIONS = 250_000;
const LOCATOR_PREFIX = 'my-office-assistant-sync-v1:';
export const CONFLICT_SUFFIX = ' (conflict copy)';

function normalizedPassphrase(passphrase) {
  const value = String(passphrase ?? '').normalize('NFKC').trim();
  if (value.length < 12) throw new Error('Sync passphrase must contain at least 12 characters');
  return value;
}

function toBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(String(value));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

// A tombstone without a valid deletion time carries no usable ordering information,
// so it is dropped and can never delete a note.
function normalizeTombstones(value) {
  if (!Array.isArray(value)) return [];
  const latest = new Map();
  for (const item of value) {
    if (!item || typeof item.id !== 'string' || typeof item.deletedAt !== 'string') continue;
    if (!Number.isFinite(timestampValue(item.deletedAt))) continue;
    const current = latest.get(item.id);
    const order = current ? compareTimestamps(item.deletedAt, current.deletedAt) : 1;
    if (order > 0 || (order === 0 && item.deletedAt > current.deletedAt)) latest.set(item.id, item);
  }
  return [...latest.values()].sort(
    (a, b) => compareTimestamps(b.deletedAt, a.deletedAt) || a.id.localeCompare(b.id),
  );
}

function normalizeState(value) {
  return {
    notes: normalizeNotes(value?.notes),
    tombstones: normalizeTombstones(value?.tombstones),
  };
}

export function normalizeSyncState(value) {
  return normalizeState(value);
}

function contentKey(note) {
  return `${note.title}\u0000${note.content}`;
}

function sameContent(a, b) {
  return a.title === b.title && a.content === b.content;
}

function hasValidTimestamp(note) {
  return Number.isFinite(timestampValue(note.updatedAt));
}

// Positive when `a` should win over `b`. Invalid timestamps are oldest; equal
// timestamps fall back to content and then the full record so the result never
// depends on which side was listed first.
function compareVersions(a, b) {
  const byTime = compareTimestamps(a.updatedAt, b.updatedAt);
  if (byTime) return byTime;
  const left = contentKey(a);
  const right = contentKey(b);
  if (left !== right) return left > right ? 1 : -1;
  const leftRecord = JSON.stringify(a);
  const rightRecord = JSON.stringify(b);
  if (leftRecord === rightRecord) return 0;
  return leftRecord > rightRecord ? 1 : -1;
}

function newer(a, b) {
  return compareVersions(a, b) >= 0 ? a : b;
}

function newestById(list) {
  const byId = new Map();
  for (const item of list) {
    const current = byId.get(item.id);
    if (!current || compareVersions(item, current) > 0) byId.set(item.id, item);
  }
  return byId;
}

// Deterministic 64-bit (two 32-bit lanes) string hash used to recognise note versions.
export function noteFingerprint(note) {
  const value = contentKey(note);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

// The sync base records, per note id, the version both this device and the cloud
// last agreed on. It lives only in local storage, never inside the encrypted envelope.
export function createSyncBase(value) {
  const base = {};
  for (const note of normalizeState(value).notes) base[note.id] = noteFingerprint(note);
  return base;
}

// After a merge, every note whose merged version equals the remote version is a
// version both sides now share, so it becomes the new base for that note.
export function advanceSyncBase(base, mergedValue, remoteValue) {
  const next = { ...(base && typeof base === 'object' ? base : {}) };
  const remote = newestById(normalizeState(remoteValue).notes);
  for (const note of normalizeState(mergedValue).notes) {
    const theirs = remote.get(note.id);
    if (theirs && sameContent(theirs, note)) next[note.id] = noteFingerprint(note);
  }
  return next;
}

function conflictCopy(note) {
  return {
    ...note,
    id: `${note.id}-conflict-${noteFingerprint(note)}`,
    title: `${note.title.trim() || 'Untitled'}${CONFLICT_SUFFIX}`,
    conflictOf: note.id,
  };
}

async function deriveEncryptionKey(passphrase, salt) {
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(normalizedPassphrase(passphrase)),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function deriveSyncLocator(passphrase) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(`${LOCATOR_PREFIX}${normalizedPassphrase(passphrase)}`),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Merge two notebook states.
 *
 * Without `options.base` (or for a note the base does not know), the newest
 * `updatedAt` wins. With a base (id -> noteFingerprint of the last agreed version):
 * - only one side changed: that side's edit wins;
 * - both sides changed to different text: the newer version keeps the id and the
 *   other is preserved as a separate "(conflict copy)" note, reported in `conflicts`.
 */
export function mergeSyncStates(localValue, remoteValue, options = {}) {
  const base = options.base && typeof options.base === 'object' ? options.base : null;
  const local = normalizeState(localValue);
  const remote = normalizeState(remoteValue);
  const localNotes = newestById(local.notes);
  const notes = new Map(localNotes);
  const copies = [];
  const conflicts = [];

  for (const [id, theirs] of newestById(remote.notes)) {
    const ours = notes.get(id);
    if (!ours || sameContent(ours, theirs)) {
      notes.set(id, ours ? newer(ours, theirs) : theirs);
      continue;
    }
    const agreed = base ? base[id] : undefined;
    if (typeof agreed !== 'string') {
      notes.set(id, newer(ours, theirs));
      continue;
    }
    const oursChanged = noteFingerprint(ours) !== agreed;
    const theirsChanged = noteFingerprint(theirs) !== agreed;
    const changedSide = oursChanged && !theirsChanged ? ours : !oursChanged && theirsChanged ? theirs : null;
    if (changedSide && hasValidTimestamp(changedSide)) {
      // If the edit carries an older clock than the version it replaces, re-stamp it just
      // after that version so timestamp-only merges (other tabs, older clients) keep it too.
      const replaced = changedSide === ours ? theirs : ours;
      notes.set(id, compareTimestamps(changedSide.updatedAt, replaced.updatedAt) > 0
        ? changedSide
        : { ...changedSide, updatedAt: nextTimestamp(replaced.updatedAt, 0) });
      continue;
    }
    if (!oursChanged && !theirsChanged) {
      notes.set(id, newer(ours, theirs));
      continue;
    }
    const winner = newer(ours, theirs);
    const loser = winner === ours ? theirs : ours;
    const copy = conflictCopy(loser);
    notes.set(id, winner);
    copies.push(copy);
    if (!localNotes.has(copy.id)) {
      conflicts.push({
        id,
        copyId: copy.id,
        title: winner.title.trim() || loser.title.trim() || 'Untitled',
        kept: winner === ours ? 'local' : 'remote',
        copied: loser === ours ? 'local' : 'remote',
      });
    }
  }
  for (const copy of copies) {
    const current = notes.get(copy.id);
    notes.set(copy.id, current ? newer(current, copy) : copy);
  }

  const tombstones = new Map();
  for (const item of [...local.tombstones, ...remote.tombstones]) {
    const current = tombstones.get(item.id);
    const order = current ? compareTimestamps(item.deletedAt, current.deletedAt) : 1;
    if (order > 0 || (order === 0 && item.deletedAt > current.deletedAt)) tombstones.set(item.id, item);
  }
  for (const [id, deletion] of tombstones) {
    const currentNote = notes.get(id);
    if (!currentNote || compareTimestamps(deletion.deletedAt, currentNote.updatedAt) >= 0) {
      notes.delete(id);
    } else {
      tombstones.delete(id);
    }
  }
  const merged = normalizeState({ notes: [...notes.values()], tombstones: [...tombstones.values()] });
  return {
    ...merged,
    conflicts: conflicts.filter((conflict) => notes.has(conflict.copyId)),
  };
}

/**
 * Explicit import restores notes that were previously deleted on this device:
 * an imported note that an existing tombstone would suppress is re-timestamped
 * to `now` so it wins over the deletion everywhere it synchronizes.
 */
export function importIntoState(stateValue, importedValue, { now = new Date().toISOString() } = {}) {
  const current = normalizeState(stateValue);
  const existing = newestById(current.notes);
  const deletions = new Map(current.tombstones.map((item) => [item.id, item]));
  const counts = { added: 0, updated: 0, restored: 0, unchanged: 0 };
  const restoredIds = new Set();
  const prepared = [...newestById(normalizeNotes(importedValue)).values()].map((note) => {
    const deletion = deletions.get(note.id);
    if (!existing.has(note.id) && deletion && compareTimestamps(deletion.deletedAt, note.updatedAt) >= 0) {
      restoredIds.add(note.id);
      return { ...note, updatedAt: nextTimestamp(deletion.deletedAt, timestampValue(now)) };
    }
    return note;
  });
  counts.restored = restoredIds.size;
  const merged = mergeSyncStates(current, { notes: prepared, tombstones: [] });
  const result = newestById(merged.notes);
  for (const note of prepared) {
    if (restoredIds.has(note.id)) continue;
    const before = existing.get(note.id);
    if (!before) {
      counts.added += 1;
      continue;
    }
    const imported = JSON.stringify(note);
    const kept = JSON.stringify(result.get(note.id));
    if (kept === imported && JSON.stringify(before) !== imported) counts.updated += 1;
    else counts.unchanged += 1;
  }
  return { state: { notes: merged.notes, tombstones: merged.tombstones }, ...counts, total: prepared.length };
}

async function verifierHash(passphrase, salt) {
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(normalizedPassphrase(passphrase)),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    material,
    256,
  );
  return [...new Uint8Array(bits)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Local-only record of the passphrase last used on this device: a salted PBKDF2 hash
// and the notebook locator it opens. It never contains the passphrase and is never uploaded.
export async function createPassphraseVerifier(passphrase, { salt = crypto.getRandomValues(new Uint8Array(16)) } = {}) {
  return {
    version: 1,
    salt: toBase64(salt),
    hash: await verifierHash(passphrase, salt),
    locator: await deriveSyncLocator(passphrase),
  };
}

export async function matchesPassphraseVerifier(verifier, passphrase) {
  if (!verifier || verifier.version !== 1 || typeof verifier.salt !== 'string' || typeof verifier.hash !== 'string') {
    return false;
  }
  const hash = await verifierHash(passphrase, fromBase64(verifier.salt));
  let difference = hash.length ^ verifier.hash.length;
  for (let index = 0; index < hash.length; index += 1) {
    difference |= hash.charCodeAt(index) ^ verifier.hash.charCodeAt(index);
  }
  return difference === 0;
}

export async function encryptSyncState(value, passphrase) {
  const state = normalizeState(value);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveEncryptionKey(passphrase, salt);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(JSON.stringify(state)),
  );
  return {
    version: 1,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
    updatedAt: new Date().toISOString(),
  };
}

export async function decryptSyncState(payload, passphrase) {
  if (!payload || payload.version !== 1 || !payload.salt || !payload.iv || !payload.ciphertext) {
    throw new Error('Unsupported encrypted notebook format');
  }
  const salt = fromBase64(payload.salt);
  const iv = fromBase64(payload.iv);
  const key = await deriveEncryptionKey(passphrase, salt);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    fromBase64(payload.ciphertext),
  );
  return normalizeState(JSON.parse(decoder.decode(plaintext)));
}
