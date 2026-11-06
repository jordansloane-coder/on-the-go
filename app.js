// On The Go — UI + glue. Data: db.js · receipt reading: scan.js · Drive backup: backup.js · export: export.js
// Design rule: capture must be faster than losing the receipt. Never put a form in front of it.
// Photos are saved instantly; reading them (vendor/amount/category…) happens in the background.

const $ = (id) => document.getElementById(id);
const STALE_DAYS = 3; // nudge to offload after this many days with unexported items
const DEFAULT_CATEGORIES = ['Food', 'Groceries', 'Gas', 'Lodging', 'Supplies', 'Transport', 'Other'];

let items = [];
let objectUrls = [];
let editingId = null;
let settings = { apiKey: '', categories: [], lastBackupAt: null };

// ---------- helpers ----------
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
const money = (n) => (n == null ? '' : '$' + Number(n).toFixed(2));
const pad = (n) => String(n).padStart(2, '0');
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const fmtDay = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const safeGet = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const safeSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const allCategories = () => [...new Set([...DEFAULT_CATEGORIES, ...settings.categories])];
const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 36 ? `${h} hr ago` : `${Math.round(h / 24)} days ago`;
};

let toastTimer;
function toast(msg, actionLabel, action) {
  const t = $('toast');
  t.textContent = msg + ' ';
  if (actionLabel) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = actionLabel;
    b.onclick = () => { t.hidden = true; action(); };
    t.appendChild(b);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4500);
}

// Fields a Saturation-bound line item must have so the team knows what it was.
function missingFields(it) {
  const m = [];
  if (!it.vendor) m.push('vendor');
  if (it.amount == null) m.push('amount');
  if (!it.category) m.push('category');
  return m;
}

async function sha256(blob) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch { return ''; }
}

// Likely duplicate: identical photo, or same vendor + amount + date. Never blocks — only asks.
// (Standalone on purpose; same logic is being added to the Quick Budget app.)
function findDuplicate(it) {
  const norm = (s) => (s || '').trim().toLowerCase();
  return items.find((o) =>
    o.id !== it.id && (
      (it.hash && o.hash === it.hash) ||
      (it.amount != null && o.amount === it.amount && norm(it.vendor) && norm(o.vendor) === norm(it.vendor) && o.date === it.date)
    )
  );
}

async function confirmNotDuplicate(it) {
  if (it.dupAsked) return true;
  const dup = findDuplicate(it);
  if (!dup) return true;
  it.dupAsked = true;
  await DB.put(it);
  const what = [dup.vendor || 'a receipt', money(dup.amount), dup.date && 'on ' + fmtDay(dup.date)].filter(Boolean).join(' ');
  if (confirm(`Looks like a duplicate of ${what} already in your pile.\n\nOK = keep it anyway\nCancel = remove the new one`)) return true;
  await DB.remove(it.id);
  return false;
}

// ---------- capture ----------
async function addItem(fields) {
  const item = {
    id: uid(), createdAt: Date.now(),
    photo: null, photoName: '', photoType: '', hash: '',
    date: todayISO(), vendor: '', amount: null, category: '', address: '', note: '',
    reimbursement: false, companyExpense: false,
    label: $('label').value.trim(),
    scan: '', scanError: '', needsReview: false, driveId: '',
    status: 'new',
    ...fields,
  };
  await DB.put(item);
  return item;
}

async function addFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const saved = [];
  for (const f of files) {
    const blob = await Scan.prepare(f);
    const hash = await sha256(blob);
    const name = blob === f ? f.name : (f.name || 'receipt').replace(/\.[^.]+$/, '') + '.jpg';
    const item = await addItem({
      photo: blob, photoName: name, photoType: blob.type || f.type, hash,
      scan: settings.apiKey ? 'pending' : '',
    });
    saved.push(item);
  }
  await refresh();
  toast(files.length > 1 ? `Saved ${files.length} receipts.` : 'Saved.',
    settings.apiKey ? '' : 'Add details',
    () => openEdit(saved[saved.length - 1].id));
  runScanQueue();
}

$('btn-snap').onclick = () => $('in-snap').click();
$('btn-files').onclick = () => $('in-files').click();
for (const id of ['in-snap', 'in-files']) {
  $(id).onchange = async (e) => {
    await addFiles(e.target.files);
    e.target.value = '';
  };
}
$('btn-quick').onclick = async () => {
  const item = await addItem({});
  await refresh();
  openEdit(item.id, true);
};
$('label').value = safeGet('label');
$('label').oninput = () => safeSet('label', $('label').value);

// ---------- background receipt reading ----------
let scanning = false;
async function runScanQueue() {
  if (scanning || !settings.apiKey) return;
  scanning = true;
  try {
    for (;;) {
      const it = items.find((i) => i.scan === 'pending' && i.photo);
      if (!it) break;
      try {
        const p = await Scan.readReceipt(it.photo, settings.apiKey, allCategories());
        // Only fill blanks — anything the user already typed wins.
        if (!it.vendor && p.vendor) it.vendor = p.vendor;
        if (it.amount == null && p.total != null) it.amount = p.total;
        if (p.date && it.date === todayISO()) it.date = p.date;
        if (!it.category && p.category) it.category = allCategories().find((c) => c.toLowerCase() === p.category.toLowerCase()) || p.category;
        if (!it.address && p.address) it.address = p.address;
        it.scan = 'done'; it.scanError = ''; it.needsReview = true;
        await DB.put(it);
        await refresh();
        await confirmNotDuplicate(it);
        await refresh();
      } catch (e) {
        it.scan = 'failed'; it.scanError = e.message;
        await DB.put(it);
        await refresh();
        if (/Offline|rejected|Rate/.test(e.message)) { toast(e.message); break; }
      }
    }
  } finally { scanning = false; }
}

// ---------- list ----------
function rowFor(item) {
  const li = document.createElement('li');
  li.className = 'item';

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  if (item.photo && item.photoType.startsWith('image/')) {
    const img = document.createElement('img');
    const url = URL.createObjectURL(item.photo);
    objectUrls.push(url);
    img.src = url; img.alt = '';
    thumb.appendChild(img);
  } else {
    thumb.textContent = item.photo ? 'PDF' : '✎';
  }

  const body = document.createElement('div');
  body.className = 'item-body';
  const title = document.createElement('div');
  title.className = 'item-title';
  title.textContent = item.vendor || item.note || (item.scan === 'pending' ? 'Reading receipt…' : item.photo ? 'Receipt' : 'Entry');
  const meta = document.createElement('div');
  meta.className = 'item-meta';
  meta.textContent = [fmtDay(item.date || todayISO()), item.category, item.label].filter(Boolean).join(' · ');
  body.append(title, meta);

  if (item.status === 'new' && item.scan !== 'pending') {
    const miss = missingFields(item);
    if (miss.length || item.scan === 'failed') {
      const chip = document.createElement('div');
      chip.className = 'item-chip warn';
      chip.textContent = item.scan === 'failed' && !miss.length ? 'read failed' : 'NEEDS: ' + miss.join(', ');
      body.append(chip);
    } else if (item.needsReview) {
      const chip = document.createElement('div');
      chip.className = 'item-chip';
      chip.textContent = 'check details';
      body.append(chip);
    }
  }

  const amt = document.createElement('div');
  amt.className = 'item-amount' + (item.amount == null ? ' missing' : '');
  amt.textContent = item.amount == null ? '$?' : money(item.amount);

  li.append(thumb, body, amt);
  li.tabIndex = 0;
  li.setAttribute('role', 'button');
  li.setAttribute('aria-label', `${title.textContent}, ${amt.textContent}. Open details`);
  li.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEdit(item.id); } };
  li.onclick = () => openEdit(item.id);
  return li;
}

function renderExportFilter(pending) {
  const sel = $('export-filter');
  const prev = sel.value;
  const labels = [...new Set(pending.map((i) => i.label).filter(Boolean))];
  sel.innerHTML = '';
  sel.add(new Option(`Everything (${pending.length})`, '__all'));
  for (const l of labels) sel.add(new Option(`${l} (${pending.filter((i) => i.label === l).length})`, l));
  if (labels.length && pending.some((i) => !i.label)) {
    sel.add(new Option(`No label (${pending.filter((i) => !i.label).length})`, '__none'));
  }
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

function renderBackupStatus(pending) {
  const el = $('backup-status');
  const connected = !!settings.lastBackupAt;
  const dirty = items.filter((i) => !settings.lastBackupAt || i.updatedAt > settings.lastBackupAt).length;
  if (!items.length) { el.hidden = true; return; }
  el.hidden = false;
  el.replaceChildren();
  if (!connected) {
    el.textContent = 'Not backed up yet. ';
  } else if (dirty) {
    el.textContent = `${dirty} change${dirty > 1 ? 's' : ''} not backed up (last: ${ago(settings.lastBackupAt)}). `;
  } else {
    el.textContent = `Backed up ${ago(settings.lastBackupAt)}.`;
    return;
  }
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = 'Back up now';
  b.onclick = doBackup;
  el.append(b);
}

async function refresh() {
  items = await DB.all();
  objectUrls.forEach(URL.revokeObjectURL);
  objectUrls = [];

  const pending = items.filter((i) => i.status === 'new');
  const done = items.filter((i) => i.status === 'exported');

  $('count').textContent = pending.length ? `${pending.length} in pile` : '';
  $('list').replaceChildren(...pending.map(rowFor));
  $('empty').hidden = pending.length > 0;
  $('offload').hidden = pending.length === 0;
  renderExportFilter(pending);
  renderBackupStatus(pending);

  const oldest = pending.length ? Math.min(...pending.map((i) => i.createdAt)) : 0;
  const days = oldest ? Math.floor((Date.now() - oldest) / 86400000) : 0;
  $('nudge').hidden = days < STALE_DAYS;
  if (days >= STALE_DAYS) $('nudge').textContent = `Oldest item is ${days} days old. Offload soon.`;

  $('exported').hidden = done.length === 0;
  $('exported-summary').textContent = `Exported (${done.length})`;
  $('exported-list').replaceChildren(...done.map(rowFor));
}

// ---------- edit ----------
function fillCategorySelect(current) {
  const sel = $('f-category');
  sel.innerHTML = '';
  sel.add(new Option('— choose —', ''));
  const cats = allCategories();
  if (current && !cats.includes(current)) cats.push(current);
  for (const c of cats) sel.add(new Option(c, c));
  sel.value = current || '';
}

function updateMissingNote() {
  const probe = {
    vendor: $('f-vendor').value.trim(),
    amount: $('f-amount').value === '' ? null : Number($('f-amount').value),
    category: $('f-category').value,
  };
  const m = missingFields(probe);
  $('edit-missing').hidden = m.length === 0;
  $('edit-missing').textContent = m.length ? `Still needed so your team knows what this was: ${m.join(', ')}.` : '';
}
for (const id of ['f-vendor', 'f-amount', 'f-category']) $(id).addEventListener('input', updateMissingNote);

function openEdit(id, isNew = false) {
  const item = items.find((i) => i.id === id);
  if (!item) return;
  editingId = id;
  $('edit-title').textContent = isNew ? 'No-receipt entry' : 'Details';
  $('f-vendor').value = item.vendor;
  $('f-amount').value = item.amount ?? '';
  $('f-date').value = item.date || todayISO();
  fillCategorySelect(item.category);
  $('f-address').value = item.address;
  $('f-reimbursement').checked = item.reimbursement;
  $('f-companyExpense').checked = item.companyExpense;
  $('f-label').value = item.label;
  $('f-note').value = item.note;

  const scanNote = $('edit-scan');
  scanNote.hidden = !(item.scan === 'pending' || item.scan === 'failed' || item.needsReview);
  scanNote.textContent =
    item.scan === 'pending' ? 'Reading the receipt… fields will fill in. Anything you type is kept.' :
    item.scan === 'failed' ? `Couldn't read this one (${item.scanError}). Fill it in or tap Re-read.` :
    'Filled in from the receipt. Double-check the amount.';
  $('btn-reread').hidden = !(item.photo && settings.apiKey && item.scan !== 'pending');

  const img = $('edit-photo');
  if (item.photo && item.photoType.startsWith('image/')) {
    const url = URL.createObjectURL(item.photo);
    objectUrls.push(url);
    img.src = url; img.hidden = false;
  } else img.hidden = true;

  updateMissingNote();
  $('dlg-edit').showModal();
  if (!item.photo) $('f-vendor').focus();
}

async function saveEdit() {
  const item = items.find((i) => i.id === editingId);
  if (!item) return;
  const amt = $('f-amount').value;
  Object.assign(item, {
    vendor: $('f-vendor').value.trim(),
    amount: amt === '' ? null : Number(amt),
    date: $('f-date').value || todayISO(),
    category: $('f-category').value,
    address: $('f-address').value.trim(),
    reimbursement: $('f-reimbursement').checked,
    companyExpense: $('f-companyExpense').checked,
    label: $('f-label').value.trim(),
    note: $('f-note').value.trim(),
    needsReview: false,
  });
  await DB.put(item);
  await refresh();
  await confirmNotDuplicate(item);
  await refresh();
}
$('form-edit').onsubmit = saveEdit;

// Tap the receipt photo -> full screen (pinch to zoom works natively in the scroller).
$('edit-photo').onclick = () => {
  $('viewer-img').src = $('edit-photo').src;
  $('dlg-viewer').showModal();
};
$('btn-viewer-close').onclick = () => $('dlg-viewer').close();
$('dlg-viewer').onclick = (e) => { if (e.target === $('dlg-viewer') || e.target.className === 'viewer-scroll') $('dlg-viewer').close(); };

$('btn-cancel').onclick = async () => {
  const item = items.find((i) => i.id === editingId);
  // A brand-new, still-empty no-receipt entry is pointless: drop it.
  if (item && !item.photo && !item.amount && !item.note && !item.vendor) await DB.remove(item.id);
  $('dlg-edit').close();
  await refresh();
};
$('btn-delete').onclick = async () => {
  if (!confirm('Delete this item?')) return;
  await DB.remove(editingId);
  $('dlg-edit').close();
  await refresh();
};
$('btn-reread').onclick = async () => {
  const item = items.find((i) => i.id === editingId);
  if (!item) return;
  item.scan = 'pending';
  await DB.put(item);
  $('dlg-edit').close();
  await refresh();
  runScanQueue();
};

// ---------- offload ----------
function pickedForExport() {
  const v = $('export-filter').value;
  const pending = items.filter((i) => i.status === 'new');
  if (v === '__all') return pending;
  if (v === '__none') return pending.filter((i) => !i.label);
  return pending.filter((i) => i.label === v);
}

$('btn-export').onclick = async () => {
  const picked = pickedForExport();
  if (!picked.length) return;
  const incomplete = picked.filter((i) => missingFields(i).length);
  if (incomplete.length &&
      !confirm(`${incomplete.length} of ${picked.length} items are missing vendor, amount or category — your team won't know what they were.\n\nExport anyway?`)) return;
  const big = picked.filter((i) => i.photo && i.photo.size > 5 * 1024 * 1024);
  if (big.length && !confirm(`${big.length} receipt file(s) are over 5 MB, which is Saturation's upload limit. Export anyway?`)) return;
  const btn = $('btn-export');
  btn.disabled = true;
  try {
    const blob = await Exporter.build(picked);
    const stamp = new Date().toISOString().slice(0, 10);
    const file = new File([blob], `on-the-go_${stamp}.zip`, { type: 'application/zip' });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'On The Go export' }); }
      catch (e) { if (e.name === 'AbortError') return; throw e; }
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file);
      a.download = file.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }

    // Never clear the pile without asking — we can't tell if the save really happened.
    $('mark-text').textContent = `Mark these ${picked.length} items as exported? They'll leave your pile (kept under "Exported" until you delete them).`;
    $('dlg-mark').returnValue = '';
    $('dlg-mark').onclose = async () => {
      if ($('dlg-mark').returnValue !== 'yes') return;
      const now = Date.now();
      for (const it of picked) await DB.put({ ...it, status: 'exported', exportedAt: now });
      await refresh();
      toast(`${picked.length} marked exported.`);
    };
    $('dlg-mark').showModal();
  } catch (e) {
    alert('Export failed: ' + e.message);
  } finally { btn.disabled = false; }
};

$('btn-clear-exported').onclick = async () => {
  const done = items.filter((i) => i.status === 'exported');
  if (!confirm(`Permanently delete ${done.length} exported items and their receipt files from this phone? (Copies already in your Drive backup stay there.)`)) return;
  for (const it of done) await DB.remove(it.id);
  await refresh();
};

// ---------- settings + backup ----------
function renderSettingsBackup() {
  $('s-backup-status').textContent = settings.lastBackupAt
    ? `Last backup: ${ago(settings.lastBackupAt)}.`
    : 'No backup yet.';
}
$('btn-settings').onclick = () => {
  $('s-apikey').value = settings.apiKey;
  renderSettingsBackup();
  $('dlg-settings').showModal();
};
$('btn-settings-save').onclick = async () => {
  const key = $('s-apikey').value.trim();
  if (key !== settings.apiKey) {
    settings.apiKey = key;
    await DB.setMeta('apiKey', key);
    if (key) {
      // Pick up anything captured before a key existed.
      for (const it of items) if (it.photo && !it.scan && !it.vendor && it.amount == null) { it.scan = 'pending'; await DB.put(it); }
      await refresh();
      runScanQueue();
    }
  }
};
$('btn-addcat').onclick = async () => {
  const v = $('s-newcat').value.trim();
  if (!v || allCategories().some((c) => c.toLowerCase() === v.toLowerCase())) return;
  settings.categories.push(v);
  await DB.setMeta('categories', settings.categories);
  $('s-newcat').value = '';
  toast(`Added "${v}".`);
};

async function doBackup() {
  const btns = [$('btn-drive-backup')];
  btns.forEach((b) => (b.disabled = true));
  try {
    const r = await Backup.backUp(await DB.all(), (m) => ($('s-backup-status').textContent = m));
    settings.lastBackupAt = await DB.getMeta('lastBackupAt');
    renderSettingsBackup();
    await refresh();
    toast(r.uploaded ? `Backed up (${r.uploaded} new receipts).` : 'Backed up.');
  } catch (e) {
    $('s-backup-status').textContent = '';
    toast(e.message);
  } finally { btns.forEach((b) => (b.disabled = false)); }
}
$('btn-drive-backup').onclick = doBackup;
$('btn-drive-restore').onclick = async () => {
  try {
    const r = await Backup.restore(await DB.all(), (m) => ($('s-backup-status').textContent = m));
    renderSettingsBackup();
    await refresh();
    toast(r.restored ? `Restored ${r.restored} items.` : 'Nothing missing — this phone already has everything.');
  } catch (e) { $('s-backup-status').textContent = ''; toast(e.message); }
};

// ---------- boot ----------
(async function boot() {
  settings.apiKey = await DB.getMeta('apiKey', '');
  settings.categories = await DB.getMeta('categories', []);
  settings.lastBackupAt = await DB.getMeta('lastBackupAt', null);
  await refresh();
  runScanQueue(); // resume anything left "reading…" if the app was closed mid-scan
  Backup.init();
})();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js').catch(() => {});
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
