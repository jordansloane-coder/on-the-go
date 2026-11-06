// Tiny IndexedDB wrapper. Stores: "items" (the pile) and "meta" (settings, key/value).
// No trips/projects — just a pile.
//
// item = {
//   id, createdAt (ms), updatedAt (ms),
//   photo: Blob|null, photoName, photoType,   // receipt image/PDF (optional)
//   date: 'YYYY-MM-DD', vendor, amount: number|null, category, address, note,
//   reimbursement: bool, companyExpense: bool,
//   label: '',                                // optional free-text tag, e.g. "NYC shoot"
//   scan: ''|'pending'|'done'|'failed', scanError, needsReview: bool,
//   driveId: '',                              // Google Drive file id of the backed-up receipt
//   status: 'new'|'exported', exportedAt
// }

const DB = (() => {
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('on-the-go', 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => {
        req.result.onversionchange = () => req.result.close();
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function store(name, mode) {
    const db = await open();
    return db.transaction(name, mode).objectStore(name);
  }

  const wrap = (req) =>
    new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

  return {
    async all() {
      const rows = await wrap((await store('items', 'readonly')).getAll());
      return rows.sort((a, b) => b.createdAt - a.createdAt);
    },
    async get(id) {
      return wrap((await store('items', 'readonly')).get(id));
    },
    async put(item) {
      item.updatedAt = Date.now();
      await wrap((await store('items', 'readwrite')).put(item));
      return item;
    },
    async remove(id) {
      await wrap((await store('items', 'readwrite')).delete(id));
    },
    async getMeta(key, fallback = null) {
      const row = await wrap((await store('meta', 'readonly')).get(key));
      return row ? row.value : fallback;
    },
    async setMeta(key, value) {
      await wrap((await store('meta', 'readwrite')).put({ key, value }));
    },
  };
})();
