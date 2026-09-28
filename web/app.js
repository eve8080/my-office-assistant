import { createNote, deleteNote, filterNotes, nextTimestamp, normalizeNotes, upsertNote } from './note-store.js';
import {
  advanceSyncBase,
  createPassphraseVerifier,
  createSyncBase,
  decryptSyncState,
  deriveSyncLocator,
  encryptSyncState,
  importIntoState,
  matchesPassphraseVerifier,
  mergeSyncStates,
  normalizeSyncState,
} from './sync-crypto.js';

const STORAGE_KEY = 'my-office-assistant.notes.v1';
const ACTIVE_KEY = 'my-office-assistant.active-note.v1';
const TOMBSTONES_KEY = 'my-office-assistant.tombstones.v1';
const SESSION_PASSPHRASE_KEY = 'my-office-assistant.sync-passphrase.v1';
const SYNC_BASE_KEY = 'my-office-assistant.sync-base.v1';
const VERIFIER_KEY = 'my-office-assistant.passphrase-verifier.v1';
const CHANNEL_NAME = 'my-office-assistant.state.v1';
const MAX_WRITE_ATTEMPTS = 3;
const TAB_ID = crypto.randomUUID();
const elements = Object.fromEntries(
  [
    'sidebar', 'close-sidebar', 'open-sidebar', 'new-note', 'empty-new-note', 'search', 'note-list',
    'note-count', 'delete-note', 'editor-wrap', 'empty-state', 'note-title', 'note-content',
    'updated-time', 'word-count', 'save-state', 'export-notes', 'import-button', 'import-notes', 'toast',
    'sync-button', 'sync-dialog', 'sync-form', 'sync-passphrase', 'sync-confirm', 'sync-error',
    'sync-submit', 'sync-cancel', 'conflict-notice', 'conflict-message', 'conflict-open', 'conflict-dismiss',
  ].map((id) => [id, document.getElementById(id)]),
);
const mobileLayout = window.matchMedia('(max-width: 760px)');
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL_NAME) : null;

const ACCESS_DENIED_MESSAGE = 'Cloud sync access was denied (HTTP 403). Nothing was uploaded; your notes are still saved in this browser.';
const EXISTS_BUT_DENIED_MESSAGE = 'Cloud sync access was denied (HTTP 403): a cloud notebook exists for this passphrase but could not be read. Nothing was uploaded; your notes are still saved in this browser.';

class SyncError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

let { notes, tombstones } = readStoredState();
let activeId = localStorage.getItem(ACTIVE_KEY);
let syncPassphrase = sessionStorage.getItem(SESSION_PASSPHRASE_KEY) || '';
// The note and field values last exchanged between the editor DOM and note state.
// A focused field whose value differs from this has keystrokes not yet saved.
let editorState = { id: null, title: '', content: '' };
let saveTimer;
let savePending = false;
let syncTimer;
let syncInFlight = false;
let syncAgain = false;
let toastTimer;
let pendingNewNotebookLocator = '';
let conflictCopyId = null;

if (!notes.length) {
  const first = createNote();
  first.title = 'Welcome';
  first.content = 'This is your private office notebook. Your notes are saved automatically in this browser.\n\nEnable encrypted sync to keep the same notes on every computer.';
  notes = [first];
  persist();
}
if (!notes.some((note) => note.id === activeId)) activeId = notes[0]?.id ?? null;

function readJson(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

function readStoredState() {
  return normalizeSyncState({ notes: readJson(STORAGE_KEY, []), tombstones: readJson(TOMBSTONES_KEY, []) });
}

function stateKey(state) {
  return JSON.stringify(normalizeSyncState(state));
}

// Read-merge-write: never blindly overwrite what another tab stored. Returns true
// when the stored state contributed changes that this tab did not have in memory.
function persist() {
  const before = currentSyncState();
  const merged = mergeSyncStates(before, readStoredState());
  notes = merged.notes;
  tombstones = merged.tombstones;
  const pulled = stateKey(merged) !== stateKey(before);
  if (!notes.some((note) => note.id === activeId)) activeId = notes[0]?.id ?? null;
  const serializedNotes = JSON.stringify(notes);
  const serializedTombstones = JSON.stringify(tombstones);
  if (
    serializedNotes !== localStorage.getItem(STORAGE_KEY) ||
    serializedTombstones !== localStorage.getItem(TOMBSTONES_KEY)
  ) {
    localStorage.setItem(STORAGE_KEY, serializedNotes);
    localStorage.setItem(TOMBSTONES_KEY, serializedTombstones);
    channel?.postMessage({ type: 'state-changed', from: TAB_ID });
  }
  if (activeId) localStorage.setItem(ACTIVE_KEY, activeId);
  else localStorage.removeItem(ACTIVE_KEY);
  return pulled;
}

function currentSyncState() {
  return { notes: [...notes], tombstones: [...tombstones] };
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
    if (note.id === activeId) button.setAttribute('aria-current', 'true');
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

// Update one editor field without discarding unsaved keystrokes or moving the caret.
function writeField(field, key, value) {
  if (field.value === value) {
    editorState[key] = value;
    return;
  }
  const focused = document.activeElement === field;
  if (focused && field.value !== editorState[key]) return;
  const { selectionStart, selectionEnd, selectionDirection } = field;
  field.value = value;
  editorState[key] = value;
  if (focused) {
    field.setSelectionRange(
      Math.min(selectionStart, value.length),
      Math.min(selectionEnd, value.length),
      selectionDirection || 'none',
    );
  }
}

function renderEditor() {
  const note = activeNote();
  const hasNote = Boolean(note);
  elements['editor-wrap'].hidden = !hasNote;
  elements['empty-state'].hidden = hasNote;
  elements['delete-note'].hidden = !hasNote;
  if (!note) {
    editorState = { id: null, title: '', content: '' };
    return;
  }
  if (editorState.id !== note.id) {
    elements['note-title'].value = note.title;
    elements['note-content'].value = note.content;
    editorState = { id: note.id, title: note.title, content: note.content };
  } else {
    writeField(elements['note-title'], 'title', note.title);
    writeField(elements['note-content'], 'content', note.content);
  }
  elements['updated-time'].textContent = `Updated ${formatDate(note.updatedAt)}`;
  updateWordCount();
}

function render() {
  renderList();
  renderEditor();
  elements['sync-button'].textContent = syncPassphrase ? 'Sync now' : 'Enable sync';
}

function isMobileSidebar() {
  return mobileLayout.matches;
}

function updateSidebarState() {
  const open = elements.sidebar.classList.contains('open');
  elements['open-sidebar'].setAttribute('aria-expanded', String(open));
  // Off-canvas and closed on mobile: remove it from focus order and the accessibility tree.
  elements.sidebar.inert = isMobileSidebar() && !open;
}

function openSidebar() {
  elements.sidebar.classList.add('open');
  updateSidebarState();
  elements['close-sidebar'].focus();
}

function closeSidebar({ restoreFocus = true } = {}) {
  const wasOpen = elements.sidebar.classList.contains('open');
  elements.sidebar.classList.remove('open');
  updateSidebarState();
  if (wasOpen && restoreFocus && isMobileSidebar()) elements['open-sidebar'].focus();
}

function selectNote(id) {
  flushSave();
  activeId = id;
  persist();
  render();
  closeSidebar({ restoreFocus: false });
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
  closeSidebar({ restoreFocus: false });
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
  savePending = true;
  setSaveState('saving', 'Saving…');
  updateWordCount();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 350);
}

// Move editor keystrokes into note state (memory only). Returns true when the note changed.
function captureEditor() {
  clearTimeout(saveTimer);
  savePending = false;
  const note = notes.find((item) => item.id === editorState.id);
  if (!note || elements['editor-wrap'].hidden) return false;
  const title = elements['note-title'].value;
  const content = elements['note-content'].value;
  editorState.title = title;
  editorState.content = content;
  if (note.title === title && note.content === content) return false;
  notes = upsertNote(notes, { ...note, title, content, updatedAt: nextTimestamp(note.updatedAt) });
  tombstones = tombstones.filter((item) => item.id !== note.id);
  return true;
}

function reportSaved(changed, cloud) {
  if (syncPassphrase) {
    setSaveState(changed && cloud ? 'saving' : 'synced', changed && cloud ? 'Saved; sync queued' : 'Synced');
  } else {
    setSaveState('local', 'Saved locally');
  }
}

function flushSave(options = {}) {
  const { cloud = true } = options;
  const changed = captureEditor();
  const pulled = changed && persist();
  if (!activeNote()) return;
  reportSaved(changed, cloud);
  if (pulled) render();
  else renderList();
  const saved = activeNote();
  if (saved) elements['updated-time'].textContent = `Updated ${formatDate(saved.updatedAt)}`;
  if (changed && cloud) queueCloudSync();
}

// Another tab changed the shared store: keep this tab's unsaved typing, then merge.
function applyExternalState() {
  const captured = captureEditor();
  const pulled = persist();
  if (pulled) render();
  else if (captured) renderList();
  if (captured) reportSaved(true, Boolean(syncPassphrase));
  if (captured || pulled) queueCloudSync();
}

function removeActiveNote() {
  const note = activeNote();
  if (!note) return;
  if (!window.confirm(`Delete “${displayTitle(note)}”? This cannot be undone.`)) return;
  clearTimeout(saveTimer);
  savePending = false;
  const deletedAt = nextTimestamp(note.updatedAt);
  notes = deleteNote(notes, note.id);
  tombstones = [...tombstones.filter((item) => item.id !== note.id), { id: note.id, deletedAt }];
  activeId = notes[0]?.id ?? null;
  persist();
  render();
  queueCloudSync();
  showToast('Note deleted');
}

// 404: no notebook yet. 403 is ambiguous: S3 answers 403 for a missing object when the
// caller lacks s3:ListBucket, and also for a real access denial. It is returned as
// `readDenied` and resolved by evidence (a create-only write), never by assumption.
async function requestRemote(locator) {
  const response = await fetch(`/sync/notebooks/${locator}.json`, { cache: 'no-store' });
  if (response.status === 404) return { payload: null, etag: null, readDenied: false };
  if (response.status === 403) return { payload: null, etag: null, readDenied: true };
  if (!response.ok) {
    throw new SyncError(`Cloud sync failed (${response.status}). Your notes are still saved in this browser.`, 'http');
  }
  return { payload: await response.json(), etag: response.headers.get('ETag'), readDenied: false };
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// `condition` is { 'If-Match': etag } to replace a known version, { 'If-None-Match': '*' }
// to create a notebook that must not exist yet, or null when no version tag is available.
async function writeRemote(locator, payload, condition) {
  const body = JSON.stringify(payload);
  const response = await fetch(`/sync/notebooks/${locator}.json`, {
    method: 'PUT',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      'x-amz-content-sha256': await sha256Hex(body),
      ...(condition || {}),
    },
    body,
  });
  if (response.status === 412 || response.status === 409 || response.status === 404) {
    throw new SyncError('The cloud notebook changed during sync.', 'conflict');
  }
  if (response.status === 403) {
    throw new SyncError(ACCESS_DENIED_MESSAGE, 'forbidden');
  }
  if (!response.ok) {
    throw new SyncError(`Cloud sync failed (${response.status}). Your notes are still saved in this browser.`, 'http');
  }
}

function loadSyncBase(locator) {
  const stored = readJson(SYNC_BASE_KEY, null);
  return stored && stored.locator === locator && stored.notes && typeof stored.notes === 'object' ? stored.notes : null;
}

function saveSyncBase(locator, base) {
  localStorage.setItem(SYNC_BASE_KEY, JSON.stringify({ locator, notes: base }));
}

function loadVerifier() {
  return readJson(VERIFIER_KEY, null);
}

async function isKnownPassphrase(passphrase) {
  const verifier = loadVerifier();
  return !verifier || matchesPassphraseVerifier(verifier, passphrase);
}

async function rememberPassphrase(passphrase) {
  const verifier = loadVerifier();
  if (verifier && (await matchesPassphraseVerifier(verifier, passphrase))) return;
  localStorage.setItem(VERIFIER_KEY, JSON.stringify(await createPassphraseVerifier(passphrase)));
}

function editorFocused() {
  return document.activeElement === elements['note-title'] || document.activeElement === elements['note-content'];
}

function showConflicts(conflicts) {
  if (!conflicts.length) return;
  conflictCopyId = conflicts[0].copyId;
  const [first] = conflicts;
  elements['conflict-message'].textContent = conflicts.length === 1
    ? `“${first.title}” was changed on this device and in the cloud at the same time. Both versions were kept: the ${first.copied === 'local' ? 'version from this device' : 'cloud version'} is saved as a separate “(conflict copy)” note.`
    : `${conflicts.length} notes were changed on this device and in the cloud at the same time. Both versions of each were kept as separate “(conflict copy)” notes.`;
  elements['conflict-open'].hidden = conflicts.length !== 1;
  elements['conflict-notice'].hidden = false;
}

// Merge a decrypted remote state into this tab. Unsaved typing is captured first so it
// takes part in the merge. Returns the snapshot to upload.
function applyRemoteState(locator, remote) {
  captureEditor();
  if (remote) {
    const base = loadSyncBase(locator);
    const result = mergeSyncStates(currentSyncState(), remote, { base });
    notes = result.notes;
    tombstones = result.tombstones;
    saveSyncBase(locator, advanceSyncBase(base, result, remote));
    for (const conflict of result.conflicts) {
      // Keep the person typing in their own version: follow it into the copy.
      if (conflict.id === activeId && conflict.copied === 'local' && editorFocused()) {
        activeId = conflict.copyId;
        editorState.id = conflict.copyId;
      }
    }
    showConflicts(result.conflicts);
  }
  persist();
  render();
  return currentSyncState();
}

async function syncWithCloud({ allowNewNotebook = false } = {}) {
  if (!syncPassphrase) return null;
  if (syncInFlight) {
    syncAgain = true;
    return null;
  }
  syncInFlight = true;
  const passphrase = syncPassphrase;
  setSaveState('saving', 'Syncing…');
  try {
    const locator = await deriveSyncLocator(passphrase);
    let retries = 0;
    let unprotected = false;
    let created = false;
    for (let attempt = 1; ; attempt += 1) {
      const { payload, etag, readDenied } = await requestRemote(locator);
      let remote = null;
      if (payload) {
        try {
          remote = await decryptSyncState(payload, passphrase);
        } catch {
          throw new SyncError('Unable to unlock the cloud notebook. Check the sync passphrase.', 'decrypt');
        }
      } else if (!allowNewNotebook && !(await isKnownPassphrase(passphrase))) {
        // The same gate applies to 404 and to an unverified 403: nothing is written.
        throw new SyncError(
          readDenied
            ? 'No cloud notebook was found for this passphrase (the cloud did not confirm one exists), and it is not the passphrase last used on this device. Check it for typos. Nothing was uploaded.'
            : 'No cloud notebook exists for this passphrase, and it is not the passphrase last used on this device. Check it for typos. Nothing was uploaded.',
          'confirm-new-notebook',
        );
      }
      let condition = { 'If-None-Match': '*' };
      if (payload && etag) condition = { 'If-Match': etag };
      if (payload && !etag) {
        // Never happens with S3 behind CloudFront; surfaced rather than hidden if an origin omits it.
        unprotected = true;
        condition = null;
        console.warn('Cloud notebook response had no ETag; this write cannot be protected against concurrent changes.');
      }
      const uploaded = applyRemoteState(locator, remote);
      const encrypted = await encryptSyncState(uploaded, passphrase);
      try {
        await writeRemote(locator, encrypted, condition);
        saveSyncBase(locator, createSyncBase(uploaded));
        created = !payload;
        break;
      } catch (error) {
        // After a 403 read, the create-only write is the evidence: 412/409 means the notebook
        // exists but cannot be read, and 403 means writes are denied too. Either way this is an
        // access denial, not a lost race, so it is never retried.
        if (readDenied && (error.code === 'conflict' || error.code === 'forbidden')) {
          throw new SyncError(error.code === 'conflict' ? EXISTS_BUT_DENIED_MESSAGE : ACCESS_DENIED_MESSAGE, 'forbidden');
        }
        if (error.code !== 'conflict') throw error;
        if (attempt >= MAX_WRITE_ATTEMPTS) {
          throw new SyncError(
            `The cloud notebook kept changing during sync (${attempt} attempts). Your notes are saved in this browser; select Sync now to try again.`,
            'conflict',
          );
        }
        retries += 1;
        setSaveState('saving', `Cloud changed; merging and retrying (${attempt + 1}/${MAX_WRITE_ATTEMPTS})…`);
      }
    }
    if (!savePending) {
      let text = 'Synced';
      if (created) text = 'Synced (created a new cloud notebook)';
      else if (unprotected) text = 'Synced (no version check)';
      else if (retries) text = `Synced after ${retries} ${retries === 1 ? 'retry' : 'retries'}`;
      setSaveState('synced', text);
    }
    return { retries, unprotected, created };
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

function syncSummary(result, fallback) {
  if (result?.created) return 'Created a new encrypted cloud notebook';
  if (result?.unprotected) return 'Synced, but the cloud did not return a version tag, so concurrent changes could not be checked';
  if (result?.retries) return `The cloud notebook changed during sync; merged and retried ${result.retries} ${result.retries === 1 ? 'time' : 'times'}`;
  return fallback;
}

function queueCloudSync(delay = 900) {
  if (!syncPassphrase) return;
  clearTimeout(syncTimer);
  setSaveState('saving', 'Sync queued…');
  syncTimer = setTimeout(() => {
    syncWithCloud()
      .then((result) => {
        if (result?.retries || result?.unprotected) showToast(syncSummary(result, ''), 5000);
      })
      .catch((error) => showToast(error instanceof Error ? error.message : 'Cloud sync failed', 6000));
  }, delay);
}

function resetNewNotebookConfirmation() {
  pendingNewNotebookLocator = '';
  elements['sync-submit'].textContent = 'Enable and sync';
}

function openSyncDialog() {
  elements['sync-error'].textContent = '';
  elements['sync-passphrase'].value = '';
  elements['sync-confirm'].value = '';
  resetNewNotebookConfirmation();
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
  const locator = await deriveSyncLocator(passphrase);
  const confirmedNewNotebook = Boolean(pendingNewNotebookLocator) && pendingNewNotebookLocator === locator;
  syncPassphrase = passphrase;
  try {
    flushSave({ cloud: false });
    const result = await syncWithCloud({ allowNewNotebook: confirmedNewNotebook });
    // Finish the UI in the same task as the "Synced" status so the modal never lingers
    // after sync succeeded; the verifier (a slow PBKDF2 derivation) is stored afterwards.
    pendingNewNotebookLocator = '';
    sessionStorage.setItem(SESSION_PASSPHRASE_KEY, syncPassphrase);
    elements['sync-dialog'].close();
    render();
    showToast(syncSummary(result, confirmedNewNotebook ? 'New encrypted notebook created' : 'Encrypted sync enabled'));
    rememberPassphrase(passphrase).catch(() => {});
  } catch (error) {
    syncPassphrase = '';
    sessionStorage.removeItem(SESSION_PASSPHRASE_KEY);
    pendingNewNotebookLocator = error?.code === 'confirm-new-notebook' ? locator : '';
    const message = error instanceof Error ? error.message : 'Unable to enable sync';
    elements['sync-error'].textContent = pendingNewNotebookLocator
      ? `${message} To create a new, separate notebook with this passphrase, select “Create new notebook”.`
      : message;
    render();
  } finally {
    elements['sync-submit'].disabled = false;
    elements['sync-submit'].textContent = pendingNewNotebookLocator ? 'Create new notebook' : 'Enable and sync';
  }
}

async function handleSyncButton() {
  if (!syncPassphrase) {
    openSyncDialog();
    return;
  }
  flushSave({ cloud: false });
  try {
    const result = await syncWithCloud();
    showToast(syncSummary(result, 'Notes are up to date'));
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Cloud sync failed', 6000);
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

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

async function importNotes(event) {
  const [file] = event.target.files;
  event.target.value = '';
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    const imported = normalizeNotes(Array.isArray(payload) ? payload : payload?.notes);
    if (!imported.length) throw new Error('No valid notes found');
    flushSave({ cloud: false });
    const result = importIntoState(currentSyncState(), imported);
    notes = result.state.notes;
    tombstones = result.state.tombstones;
    if (notes.some((note) => note.id === imported[0].id)) activeId = imported[0].id;
    persist();
    render();
    queueCloudSync();
    const details = [
      result.added && `${result.added} new`,
      result.updated && `${result.updated} updated`,
      result.restored && `${result.restored} previously deleted ${result.restored === 1 ? 'note' : 'notes'} restored`,
      result.unchanged && `${result.unchanged} already up to date`,
    ].filter(Boolean);
    showToast(`Imported ${plural(result.total, 'note')}: ${details.join(', ')}`, 6000);
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Import failed');
  }
}

function showToast(message, duration = 2300) {
  elements.toast.textContent = message;
  elements.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove('show'), duration);
}

elements['new-note'].addEventListener('click', makeNote);
elements['empty-new-note'].addEventListener('click', makeNote);
elements.search.addEventListener('input', renderList);
elements['note-title'].addEventListener('input', queueSave);
elements['note-content'].addEventListener('input', queueSave);
elements['delete-note'].addEventListener('click', removeActiveNote);
elements['export-notes'].addEventListener('click', exportNotes);
elements['import-button'].addEventListener('click', () => elements['import-notes'].click());
elements['import-notes'].addEventListener('change', importNotes);
elements['sync-button'].addEventListener('click', handleSyncButton);
elements['sync-form'].addEventListener('submit', enableSync);
elements['sync-cancel'].addEventListener('click', () => elements['sync-dialog'].close());
for (const id of ['sync-passphrase', 'sync-confirm']) {
  elements[id].addEventListener('input', () => {
    if (pendingNewNotebookLocator) resetNewNotebookConfirmation();
  });
}
elements['conflict-open'].addEventListener('click', () => {
  elements['conflict-notice'].hidden = true;
  if (conflictCopyId && notes.some((note) => note.id === conflictCopyId)) selectNote(conflictCopyId);
});
elements['conflict-dismiss'].addEventListener('click', () => {
  elements['conflict-notice'].hidden = true;
});
elements['open-sidebar'].addEventListener('click', openSidebar);
elements['close-sidebar'].addEventListener('click', () => closeSidebar());
mobileLayout.addEventListener('change', updateSidebarState);
// BroadcastChannel is the prompt notification. It can arrive before this tab can see the
// other tab's localStorage write, so the storage event (which fires once the data is
// visible, and is the only signal where BroadcastChannel is unavailable) is always handled
// too. applyExternalState is idempotent and only writes back when it adds something.
channel?.addEventListener('message', (event) => {
  if (event.data?.type === 'state-changed' && event.data.from !== TAB_ID) applyExternalState();
});
window.addEventListener('storage', (event) => {
  if (event.key === null || event.key === STORAGE_KEY || event.key === TOMBSTONES_KEY) applyExternalState();
});
window.addEventListener('beforeunload', () => flushSave({ cloud: false }));
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && isMobileSidebar() && elements.sidebar.classList.contains('open')) {
    event.preventDefault();
    closeSidebar();
    return;
  }
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

updateSidebarState();
render();
setSaveState(syncPassphrase ? 'saving' : 'local', syncPassphrase ? 'Syncing…' : 'Saved locally');
if (syncPassphrase) {
  syncWithCloud().catch((error) => showToast(error instanceof Error ? error.message : 'Cloud sync failed', 6000));
}
