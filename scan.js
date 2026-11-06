// Receipt reading via the Claude API, called straight from the browser with the user's own
// Anthropic API key (console.anthropic.com). The key lives only in this device's IndexedDB and
// is never included in backups. Same approach as the Quick Budget app.

const Scan = (() => {
  const API_URL = 'https://api.anthropic.com/v1/messages';
  const MODEL = 'claude-sonnet-5-5';

  const SYSTEM_PROMPT = `You read photos or PDFs of receipts for a film production crew member logging expenses.
Extract the vendor name, the FINAL total amount charged (not subtotal; include tax/tip if shown), the date, the printed store address/location if the receipt shows one, and a spending category.
Respond with ONLY raw JSON, no markdown fences, no commentary, matching exactly this shape:
{"vendor": string|null, "total": number|null, "date": "YYYY-MM-DD"|null, "category": string|null, "address": string|null}
Category must be one of the allowed categories listed in the user message — pick the best fit.
"Groceries" is for grocery/supermarket shopping; use "Food" for restaurants, takeout and other prepared food.
"address" is only street address / city text actually printed on the receipt, not a guess.
If a field truly cannot be determined, use null. Never fabricate a value.`;

  // Downscale photos so storage, backups and API calls stay small. PDFs pass through untouched.
  async function prepare(file, maxEdge = 1600) {
    if (!file.type.startsWith('image/')) return file;
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
      if (scale === 1 && file.size < 600000) return file;
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale);
      c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
      return blob || file;
    } catch {
      return file; // e.g. HEIC the browser can't decode — keep the original
    }
  }

  async function toBase64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function extractJson(text) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const raw = fenced ? fenced[1] : text;
    const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
    if (a === -1 || b === -1) throw new Error("Couldn't understand the response.");
    return JSON.parse(raw.slice(a, b + 1));
  }

  async function readReceipt(blob, apiKey, categories) {
    if (!apiKey) throw new Error('NO_API_KEY');
    const data = await toBase64(blob);
    const fileBlock = blob.type === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image', source: { type: 'base64', media_type: blob.type || 'image/jpeg', data } };

    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 500,
          system: SYSTEM_PROMPT,
          messages: [{
            role: 'user',
            content: [fileBlock, { type: 'text', text: `Allowed categories: ${categories.join(', ')}. Return the JSON.` }],
          }],
        }),
      });
    } catch {
      throw new Error('Offline or unreachable — will retry later.');
    }
    if (res.status === 401) throw new Error('API key rejected. Check it in Settings.');
    if (res.status === 429) throw new Error('Rate limited — try again in a moment.');
    if (!res.ok) throw new Error(`Claude API error (${res.status}).`);

    const json = await res.json();
    const block = (json.content || []).find((x) => x.type === 'text');
    if (!block) throw new Error('No readable response.');
    const p = extractJson(block.text);
    return {
      vendor: typeof p.vendor === 'string' ? p.vendor : null,
      total: typeof p.total === 'number' ? p.total : null,
      date: typeof p.date === 'string' ? p.date : null,
      category: typeof p.category === 'string' ? p.category : null,
      address: typeof p.address === 'string' ? p.address : null,
    };
  }

  return { prepare, readReceipt };
})();
