import { createNote, deleteNote, filterNotes, normalizeNotes, upsertNote } from './note-store.js';

const STORAGE_KEY = 'my-office-assistant.notes.v1';
const ACTIVE_KEY = 'my-office-assistant.active-note.v1';
const elements = Object.fromEntries(
  [
    'sidebar', 'close-sidebar', 'open-sidebar', 'new-note', 'empty-new-note', 'search', 'note-list',
    'note-count', 'delete-note', 'editor-wrap', 'empty-state', 'note-title', 'note-content',
    'updated-time', 'word-count', 'save-state', 'export-notes', 'import-notes', 'toast',
  ].map((id) => [id, document.getElementById(id)]),
);

let notes = loadNotes();
let activeId = localStorage.getItem(ACTIVE_KEY);
let saveTimer;
let toastTimer;

if (!notes.length) {
  const first = createNote();
  first.title = 'Welcome';
  first.content = 'This is your private office notebook. Your notes are saved automatically in this browser.\n\nCreate a new note whenever you want to capture a meeting point, idea or follow-up.';
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

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
  if (activeId) localStorage.setItem(ACTIVE_KEY, activeId);
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
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
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
  elements.sidebar.classList.remove('open');
  elements['note-title'].focus();
}

function updateWordCount() {
  const content = elements['note-content'].value.trim();
  const words = content ? content.split(/\s+/).length : 0;
  elements['word-count'].textContent = `${words} word${words === 1 ? '' : 's'}`;
}

function setSaving(isSaving) {
  elements['save-state'].classList.toggle('saving', isSaving);
  elements['save-state'].lastChild.textContent = isSaving ? ' Saving…' : ' Saved locally';
}

function queueSave() {
  setSaving(true);
  updateWordCount();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 350);
}

function flushSave() {
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
    persist();
  }
  setSaving(false);
  renderList();
  const saved = activeNote();
  if (saved) elements['updated-time'].textContent = `Updated ${formatDate(saved.updatedAt)}`;
}

function removeActiveNote() {
  const note = activeNote();
  if (!note) return;
  if (!window.confirm(`Delete “${displayTitle(note)}”? This cannot be undone.`)) return;
  notes = deleteNote(notes, note.id);
  activeId = notes[0]?.id ?? null;
  persist();
  render();
  showToast('Note deleted');
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
    const merged = imported.reduce((result, note) => upsertNote(result, note), notes);
    notes = merged;
    activeId = imported[0].id;
    persist();
    render();
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
elements['open-sidebar'].addEventListener('click', () => elements.sidebar.classList.add('open'));
elements['close-sidebar'].addEventListener('click', () => elements.sidebar.classList.remove('open'));
window.addEventListener('beforeunload', flushSave);
window.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    makeNote();
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    flushSave();
    showToast('Saved locally');
  }
});

render();
