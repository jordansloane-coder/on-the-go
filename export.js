// Offload: builds a CSV + renamed receipt files, packed into a ZIP (store-only, no deps).

const Exporter = (() => {
  const enc = new TextEncoder();

  // ---- CRC32 ----
  const table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // ---- ZIP (method 0 = stored) ----
  function dosDateTime(d) {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, date };
  }

  // files: [{ name: string, data: Uint8Array }]
  function buildZip(files) {
    const parts = [];
    const central = [];
    let offset = 0;
    const { time, date } = dosDateTime(new Date());

    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const crc = crc32(f.data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // UTF-8 names
      local.setUint16(8, 0, true);
      local.setUint16(10, time, true);
      local.setUint16(12, date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, f.data.length, true);
      local.setUint32(22, f.data.length, true);
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);
      parts.push(local.buffer, nameBytes, f.data);

      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true);
      cd.setUint16(12, time, true);
      cd.setUint16(14, date, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, f.data.length, true);
      cd.setUint32(24, f.data.length, true);
      cd.setUint16(28, nameBytes.length, true);
      cd.setUint32(42, offset, true);
      central.push(cd.buffer, nameBytes);

      offset += 30 + nameBytes.length + f.data.length;
    }

    const cdSize = central.reduce((n, p) => n + (p.byteLength ?? p.length), 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);

    return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
  }

  // ---- helpers ----
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const slug = (s) =>
    (s || '').trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  const csvCell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const extFor = (item) => {
    const fromName = (item.photoName || '').match(/\.([a-z0-9]+)$/i);
    if (fromName) return fromName[1].toLowerCase();
    if (item.photoType === 'application/pdf') return 'pdf';
    if (item.photoType === 'image/png') return 'png';
    return 'jpg';
  };

  function receiptFileName(item, used) {
    const parts = [item.date || ymd(item.createdAt), slug(item.vendor) || 'receipt'];
    if (item.amount != null) parts.push(Number(item.amount).toFixed(2));
    let base = parts.join('_');
    let name = `${base}.${extFor(item)}`;
    let i = 2;
    while (used.has(name)) name = `${base}_${i++}.${extFor(item)}`;
    used.add(name);
    return name;
  }

  // items oldest-first reads better in a spreadsheet
  async function build(items) {
    const ordered = [...items].sort((a, b) => a.createdAt - b.createdAt);
    const used = new Set();
    const files = [];
    const header = ['date', 'vendor', 'amount', 'description', 'category', 'address', 'reimbursement', 'company_expense', 'tags', 'note', 'receipt_file'];
    const rows = [header.join(',')];

    for (const it of ordered) {
      let fileName = '';
      if (it.photo) {
        fileName = receiptFileName(it, used);
        files.push({ name: `receipts/${fileName}`, data: new Uint8Array(await it.photo.arrayBuffer()) });
      }
      rows.push(
        [
          it.date || ymd(it.createdAt),
          it.vendor,
          it.amount != null ? Number(it.amount).toFixed(2) : '',
          [it.vendor, it.category, it.note].filter(Boolean).join(' - '), // reads as a Saturation "description"
          it.category,
          it.address,
          it.reimbursement ? 'Yes' : '',
          it.companyExpense ? 'Yes' : '',
          it.label,
          it.note,
          fileName,
        ]
          .map(csvCell)
          .join(',')
      );
    }

    files.unshift({ name: 'expenses.csv', data: enc.encode(rows.join('\r\n') + '\r\n') });
    return buildZip(files);
  }

  return { build };
})();
