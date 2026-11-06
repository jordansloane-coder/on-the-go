// Google Drive backup. Uses the drive.file scope: the app can only see files it created itself.
// Layout in the user's Drive (all created by this app):
//   on-the-go-backup.json   — every item's fields (no photos, no API key)
//   otg-<itemId>.<ext>      — one file per receipt, uploaded once
// Same Google OAuth client as the Quick Budget app (authorized for jordansloane-coder.github.io).

const Backup = (() => {
  const CLIENT_ID = '324499494473-n0m48riklpl2e1rajniop7v55363ptjf.apps.googleusercontent.com';
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const MANIFEST = 'on-the-go-backup.json';
  const API = 'https://www.googleapis.com';

  let tokenClient = null;
  let token = null;
  let tokenExpires = 0;

  function init() {
    if (typeof google === 'undefined' || !google.accounts || !google.accounts.oauth2) {
      setTimeout(init, 400); // GIS script is loaded with defer
      return;
    }
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID, scope: SCOPE, callback: () => {},
    });
  }

  function ensureToken(interactive = true) {
    return new Promise((resolve, reject) => {
      if (!tokenClient) return reject(new Error("Google sign-in isn't ready yet — try again in a moment."));
      if (token && Date.now() < tokenExpires - 60000) return resolve(token);
      tokenClient.callback = (r) => {
        if (r.error) return reject(new Error(`Google sign-in failed (${r.error}).`));
        token = r.access_token;
        tokenExpires = Date.now() + r.expires_in * 1000;
        resolve(token);
      };
      tokenClient.error_callback = () => reject(new Error('Google sign-in was cancelled.'));
      tokenClient.requestAccessToken({ prompt: interactive ? '' : 'none' });
    });
  }

  const auth = (t) => ({ Authorization: `Bearer ${t}` });

  async function findFile(t, name) {
    const q = encodeURIComponent(`name='${name}' and trashed=false`);
    const res = await fetch(`${API}/drive/v3/files?q=${q}&fields=files(id)`, { headers: auth(t) });
    if (!res.ok) throw new Error('Could not reach Google Drive.');
    return ((await res.json()).files || [])[0] || null;
  }

  // Create (or overwrite, when fileId is given) a file. body is a Blob.
  async function upload(t, { name, body, mime, fileId }) {
    if (fileId) {
      const res = await fetch(`${API}/upload/drive/v3/files/${fileId}?uploadType=media`, {
        method: 'PATCH', headers: { ...auth(t), 'content-type': mime }, body,
      });
      if (!res.ok) throw new Error(`Drive upload failed (${res.status}).`);
      return (await res.json()).id;
    }
    const boundary = 'otg' + Math.random().toString(36).slice(2);
    const meta = JSON.stringify({ name });
    const form = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
      `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`, body, `\r\n--${boundary}--`,
    ]);
    const res = await fetch(`${API}/upload/drive/v3/files?uploadType=multipart&fields=id`, {
      method: 'POST', headers: { ...auth(t), 'content-type': `multipart/related; boundary=${boundary}` }, body: form,
    });
    if (!res.ok) throw new Error(`Drive upload failed (${res.status}).`);
    return (await res.json()).id;
  }

  const extOf = (it) =>
    (it.photoName.match(/\.([a-z0-9]+)$/i) || [])[1] ||
    (it.photoType === 'application/pdf' ? 'pdf' : it.photoType === 'image/png' ? 'png' : 'jpg');

  // items: all items. onProgress(msg). Returns { uploaded }.
  async function backUp(items, onProgress = () => {}) {
    const t = await ensureToken();
    let uploaded = 0;
    const withPhotos = items.filter((i) => i.photo && !i.driveId);
    for (const [n, it] of withPhotos.entries()) {
      onProgress(`Uploading receipt ${n + 1} of ${withPhotos.length}…`);
      it.driveId = await upload(t, { name: `otg-${it.id}.${extOf(it)}`, body: it.photo, mime: it.photoType || 'application/octet-stream' });
      await DB.put(it);
      uploaded++;
    }
    onProgress('Saving item list…');
    const slim = items.map(({ photo, ...rest }) => ({ ...rest, hasPhoto: !!photo }));
    const manifest = new Blob([JSON.stringify({ version: 1, savedAt: Date.now(), items: slim })], { type: 'application/json' });
    const existing = await findFile(t, MANIFEST);
    await upload(t, { name: MANIFEST, body: manifest, mime: 'application/json', fileId: existing && existing.id });
    await DB.setMeta('lastBackupAt', Date.now());
    return { uploaded };
  }

  // Merge: adds items missing locally; never overwrites or deletes what's on this phone.
  async function restore(localItems, onProgress = () => {}) {
    const t = await ensureToken();
    const file = await findFile(t, MANIFEST);
    if (!file) throw new Error('No backup found in your Drive yet.');
    onProgress('Reading backup…');
    const res = await fetch(`${API}/drive/v3/files/${file.id}?alt=media`, { headers: auth(t) });
    if (!res.ok) throw new Error('Could not read the backup.');
    const { items } = await res.json();
    const have = new Set(localItems.map((i) => i.id));
    const missing = items.filter((i) => !have.has(i.id));
    for (const [n, it] of missing.entries()) {
      onProgress(`Restoring ${n + 1} of ${missing.length}…`);
      const { hasPhoto, ...rest } = it;
      let photo = null;
      if (hasPhoto && it.driveId) {
        const r = await fetch(`${API}/drive/v3/files/${it.driveId}?alt=media`, { headers: auth(t) });
        if (r.ok) photo = await r.blob();
      }
      await DB.put({ ...rest, photo });
    }
    return { restored: missing.length };
  }

  return { init, backUp, restore };
})();
