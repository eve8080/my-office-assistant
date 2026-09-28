import { normalizeNotes } from './note-store.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ITERATIONS = 250_000;
const LOCATOR_PREFIX = 'my-office-assistant-sync-v1:';

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

function normalizeTombstones(value) {
  if (!Array.isArray(value)) return [];
  const latest = new Map();
  for (const item of value) {
    if (!item || typeof item.id !== 'string' || typeof item.deletedAt !== 'string') continue;
    const current = latest.get(item.id);
    if (!current || Date.parse(item.deletedAt) > Date.parse(current.deletedAt)) latest.set(item.id, item);
  }
  return [...latest.values()].sort((a, b) => Date.parse(b.deletedAt) - Date.parse(a.deletedAt));
}

function normalizeState(value) {
  return {
    notes: normalizeNotes(value?.notes),
    tombstones: normalizeTombstones(value?.tombstones),
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

export function mergeSyncStates(localValue, remoteValue) {
  const local = normalizeState(localValue);
  const remote = normalizeState(remoteValue);
  const notes = new Map();
  for (const item of [...local.notes, ...remote.notes]) {
    const current = notes.get(item.id);
    if (!current || Date.parse(item.updatedAt) > Date.parse(current.updatedAt)) notes.set(item.id, item);
  }
  const tombstones = new Map();
  for (const item of [...local.tombstones, ...remote.tombstones]) {
    const current = tombstones.get(item.id);
    if (!current || Date.parse(item.deletedAt) > Date.parse(current.deletedAt)) tombstones.set(item.id, item);
  }
  for (const [id, deletion] of tombstones) {
    const currentNote = notes.get(id);
    if (!currentNote || Date.parse(deletion.deletedAt) >= Date.parse(currentNote.updatedAt)) {
      notes.delete(id);
    } else {
      tombstones.delete(id);
    }
  }
  return normalizeState({ notes: [...notes.values()], tombstones: [...tombstones.values()] });
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
