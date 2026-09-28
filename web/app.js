import { createNote, deleteNote, filterNotes, normalizeNotes, upsertNote } from './note-store.js';
import { decryptSyncState, deriveSyncLocator, encryptSyncState, mergeSyncStates } from './sync-crypto.js';

const STORAGE_KEY = 'my-office-assistant.notes.v1';
const ACTIVE_KEY = 'my-office-assistant.active-note.v1';
const TOMBSTONES_KEY = 'my-office-assistant.tombstones.v1';
const SESSION_PASSPHRASE_KEY = 'my-office-assistant.sync-passphrase.v1';
const elements = Object.fromEntries(
  [
    'sidebar', 'close-sidebar', 'open-sidebar', 'new-note', 'empty-new-note', 'search', 'note-list',
    'note-count', 'delete-note', 'editor-wrap', 'empty-state', 'note-title', 'note-content',
    'updated-time', 'word-count', 'save-state', 'export-notes', 'import-notes', 'toast',
    'sync-button', 'sync-dialog', 'sync-form', 'sync-passphrase', 'sync-confirm', 'sync-error',
    'sync-submit', 'sync-cancel',
  ].map((id) => [id, document.getElementById(id)]),
);

let notes = loadNotes();
let tombstones = loadTombstones();
let activeId = localStorage.getItem(ACTIVE_KEY);
let syncPassphrase = sessionStorage.getItem(SESSION_PASSPHRASE_KEY) || '';
let saveTimer;
let syncTimer;
let syncInFlight = false;
let syncAgain = false;
let toastTimer;

if (!notes.length) {
  const first = createNote();
  first.title = 'Welcome';
  first.content = 'This is your private office notebook. Your notes are saved automatically in this browser.\n\nEnable encrypted sync to keep the same notes on every computer.';
  notes = [first];
  persist();
}
if (!notes.some((note) => note.id === activeId)) activeId = notes[0]?.id ?? null;

function loadNotes() {
  try {
    return normalizeNotes(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'));
  } catch {
    return [];
  }
}

function loadTombstones() {
  try {
    const parsed = JSON.parse(localStorage.getItem(TOMBSTONES_KEY) || '[]');
    return Array.isArray(parsed)
      ? parsed.filter((item) => item && typeof item.id === 'string' && typeof item.deletedAt === 'string')
      : [];
  } catch {
    return [];
  }
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
  localStorage.setItem(TOMBSTONES_KEY, JSON.stringify(tombstones));
  if (activeId) localStorage.setItem(ACTIVE_KEY, activeId);
  else localStorage.removeItem(ACTIVE_KEY);
}

function currentSyncState() {
  return { notes, tombstones };
}

function activeNote() {
  return notes.find((note) => note.id === activeId) ?? null;
}

function displayTitle(note) {
  return note.title.trim() || note.content.trim().split(/\n/)[0] || 'Untitled';
}

function preview(note) {
  return note.content.replace(/\s+/g, ' ').trim() || 'Empty note';
}

function formatDate(value, compact = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  if (compact) return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(date);
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function renderList() {
  const visible = filterNotes(notes, elements.search.value);
  elements['note-count'].textContent = String(visible.length);
  elements['note-list'].replaceChildren();
  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'no-results';
    empty.textContent = 'No matching notes';
    elements['note-list'].append(empty);
    return;
  }
  visible.forEach((note) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `note-card${note.id === activeId ? ' active' : ''}`;
    button.dataset.noteId = note.id;
    button.innerHTML = `
      <span class="note-card-title"></span>
      <span class="note-card-preview"></span>
      <span class="note-card-time"></span>`;
    button.querySelector('.note-card-title').textContent = displayTitle(note);
    button.querySelector('.note-card-preview').textContent = preview(note);
    button.querySelector('.note-card-time').textContent = formatDate(note.updatedAt, true);
    button.addEventListener('click', () => selectNote(note.id));
    elements['note-list'].append(button);
  });
}

function renderEditor() {
  const note = activeNote();
  const hasNote = Boolean(note);
  elements['editor-wrap'].hidden = !hasNote;
  elements['empty-state'].hidden = hasNote;
  elements['delete-note'].hidden = !hasNote;
  if (!note) return;
  elements['note-title'].value = note.title;
  elements['note-content'].value = note.content;
  elements['updated-time'].textContent = `Updated ${formatDate(note.updatedAt)}`;
  updateWordCount();
}

function render() {
  renderList();
  renderEditor();
  elements['sync-button'].textContent = syncPassphrase ? 'Sync now' : 'Enable sync';
}

function selectNote(id) {
  flushSave();
  activeId = id;
  persist();
  render();
  elements.sidebar.classList.remove('open');
  elements['note-title'].focus();
}

function makeNote() {
  flushSave();
  const note = createNote();
  notes = upsertNote(notes, note);
  activeId = note.id;
  persist();
  elements.search.value = '';
  render();
  queueCloudSync();
  elements.sidebar.classList.remove('open');
  elements['note-title'].focus();
}

function updateWordCount() {
  const content = elements['note-content'].value.trim();
  const words = content ? content.split(/\s+/).length : 0;
  elements['word-count'].textContent = `${words} word${words === 1 ? '' : 's'}`;
}

function setSaveState(kind, text) {
  elements['save-state'].className = `save-state ${kind}`;
  const dot = elements['save-state'].querySelector('.status-dot');
  elements['save-state'].replaceChildren(dot, document.createTextNode(` ${text}`));
}

function queueSave() {
  setSaveState('saving', 'Saving…');
  updateWordCount();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 350);
}

function flushSave(options = {}) {
  const { cloud = true } = options;
  clearTimeout(saveTimer);
  const note = activeNote();
  if (!note || !elements['note-title']) return;
  const changed = note.title !== elements['note-title'].value || note.content !== elements['note-content'].value;
  if (changed) {
    const updated = {
      ...note,
      title: elements['note-title'].value,
      content: elements['note-content'].value,
      updatedAt: new Date().toISOString(),
    };
    notes = upsertNote(notes, updated);
    tombstones = tombstones.filter((item) => item.id !== updated.id);
    persist();
  }
  if (syncPassphrase) {
    setSaveState(changed && cloud ? 'saving' : 'synced', changed && cloud ? 'Saved; sync queued' : 'Synced');
  } else {
    setSaveState('local', 'Saved locally');
  }
  renderList();
  const saved = activeNote();
  if (saved) elements['updated-time'].textContent = `Updated ${formatDate(saved.updatedAt)}`;
  if (changed && cloud) queueCloudSync();
}

function removeActiveNote() {
  const note = activeNote();
  if (!note) return;
  if (!window.confirm(`Delete “${displayTitle(note)}”? This cannot be undone.`)) return;
  const deletedAt = new Date().toISOString();
  notes = deleteNote(notes, note.id);
  tombstones = [...tombstones.filter((item) => item.id !== note.id), { id: note.id, deletedAt }];
  activeId = notes[0]?.id ?? null;
  persist();
  render();
  queueCloudSync();
  showToast('Note deleted');
}

async function requestRemote(locator) {
  const response = await fetch(`/sync/notebooks/${locator}.json`, { cache: 'no-store' });
  if (response.status === 403 || response.status === 404) return null;
  if (!response.ok) throw new Error(`Cloud sync failed (${response.status})`);
  return response.json();
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function writeRemote(locator, payload) {
  const body = JSON.stringify(payload);
  const response = await fetch(`/sync/notebooks/${locator}.json`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'x-amz-content-sha256': await sha256Hex(body),
    },
    body,
  });
  if (!response.ok) throw new Error(`Cloud sync failed (${response.status})`);
}

async function syncWithCloud() {
  if (!syncPassphrase) return;
  if (syncInFlight) {
    syncAgain = true;
    return;
  }
  syncInFlight = true;
  setSaveState('saving', 'Syncing…');
  try {
    const locator = await deriveSyncLocator(syncPassphrase);
    const remotePayload = await requestRemote(locator);
    let merged = currentSyncState();
    if (remotePayload) {
      let remote;
      try {
        remote = await decryptSyncState(remotePayload, syncPassphrase);
      } catch {
        throw new Error('Unable to unlock the cloud notebook. Check the sync passphrase.');
      }
      merged = mergeSyncStates(merged, remote);
    }
    notes = merged.notes;
    tombstones = merged.tombstones;
    if (!notes.some((note) => note.id === activeId)) activeId = notes[0]?.id ?? null;
    persist();
    render();
    await writeRemote(locator, await encryptSyncState(merged, syncPassphrase));
    setSaveState('synced', 'Synced');
  } catch (error) {
    setSaveState('error', 'Sync failed');
    throw error;
  } finally {
    syncInFlight = false;
    if (syncAgain) {
      syncAgain = false;
      queueCloudSync(100);
    }
  }
}

function queueCloudSync(delay = 900) {
  if (!syncPassphrase) return;
  clearTimeout(syncTimer);
  setSaveState('saving', 'Sync queued…');
  syncTimer = setTimeout(() => {
    syncWithCloud().catch((error) => showToast(error instanceof Error ? error.message : 'Cloud sync failed'));
  }, delay);
}

function openSyncDialog() {
  elements['sync-error'].textContent = '';
  elements['sync-passphrase'].value = '';
  elements['sync-confirm'].value = '';
  elements['sync-dialog'].showModal();
  elements['sync-passphrase'].focus();
}

async function enableSync(event) {
  event.preventDefault();
  const passphrase = elements['sync-passphrase'].value.normalize('NFKC').trim();
  const confirmation = elements['sync-confirm'].value.normalize('NFKC').trim();
  elements['sync-error'].textContent = '';
  if (passphrase.length < 12) {
    elements['sync-error'].textContent = 'Use at least 12 characters.';
    return;
  }
  if (passphrase !== confirmation) {
    elements['sync-error'].textContent = 'The passphrases do not match.';
    return;
  }
  elements['sync-submit'].disabled = true;
  elements['sync-submit'].textContent = 'Syncing…';
  syncPassphrase = passphrase;
  try {
    flushSave({ cloud: false });
    await syncWithCloud();
    sessionStorage.setItem(SESSION_PASSPHRASE_KEY, syncPassphrase);
    elements['sync-dialog'].close();
    render();
    showToast('Encrypted sync enabled');
  } catch (error) {
    syncPassphrase = '';
    sessionStorage.removeItem(SESSION_PASSPHRASE_KEY);
    elements['sync-error'].textContent = error instanceof Error ? error.message : 'Unable to enable sync';
    render();
  } finally {
    elements['sync-submit'].disabled = false;
    elements['sync-submit'].textContent = 'Enable and sync';
  }
}

async function handleSyncButton() {
  if (!syncPassphrase) {
    openSyncDialog();
    return;
  }
  flushSave({ cloud: false });
  try {
    await syncWithCloud();
    showToast('Notes are up to date');
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Cloud sync failed');
  }
}

function exportNotes() {
  flushSave();
  const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), notes }, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `my-office-assistant-notes-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  showToast('Notes exported');
}

async function importNotes(event) {
  const [file] = event.target.files;
  event.target.value = '';
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    const imported = normalizeNotes(Array.isArray(payload) ? payload : payload.notes);
    if (!imported.length) throw new Error('No valid notes found');
    const merged = mergeSyncStates(currentSyncState(), { notes: imported, tombstones: [] });
    notes = merged.notes;
    tombstones = merged.tombstones;
    activeId = imported[0].id;
    persist();
    render();
    queueCloudSync();
    showToast(`${imported.length} note${imported.length === 1 ? '' : 's'} imported`);
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Import failed');
  }
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove('show'), 2300);
}

elements['new-note'].addEventListener('click', makeNote);
elements['empty-new-note'].addEventListener('click', makeNote);
elements.search.addEventListener('input', renderList);
elements['note-title'].addEventListener('input', queueSave);
elements['note-content'].addEventListener('input', queueSave);
elements['delete-note'].addEventListener('click', removeActiveNote);
elements['export-notes'].addEventListener('click', exportNotes);
elements['import-notes'].addEventListener('change', importNotes);
elements['sync-button'].addEventListener('click', handleSyncButton);
elements['sync-form'].addEventListener('submit', enableSync);
elements['sync-cancel'].addEventListener('click', () => elements['sync-dialog'].close());
elements['open-sidebar'].addEventListener('click', () => elements.sidebar.classList.add('open'));
elements['close-sidebar'].addEventListener('click', () => elements.sidebar.classList.remove('open'));
window.addEventListener('beforeunload', () => flushSave({ cloud: false }));
window.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    makeNote();
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    flushSave();
    showToast(syncPassphrase ? 'Saved and queued for sync' : 'Saved locally');
  }
});

render();
setSaveState(syncPassphrase ? 'saving' : 'local', syncPassphrase ? 'Syncing…' : 'Saved locally');
if (syncPassphrase) syncWithCloud().catch((error) => showToast(error instanceof Error ? error.message : 'Cloud sync failed'));
