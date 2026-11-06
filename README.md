# On The Go

A pocket **inbox for expenses**. Not a budget tracker.

When you're out shooting, receipts show up everywhere (camera, email, screenshots, cash).
This app's only job: **catch them fast, hold them safely, then hand them off** as a CSV + renamed
receipt files to Saturation / an expense report / a spreadsheet. All accounting happens elsewhere.

## Product rules (don't break these)
1. **Capture is faster than losing the receipt.** App opens straight to the Snap button. No form,
   no picker, no required fields before saving. Amount/vendor/etc. can be added later.
2. **One pile. No projects, trips, or budgets.** The app does not know what project anything
   belongs to — Saturation does. The optional free-text **Label** (e.g. "NYC shoot") is just a tag
   that is remembered and stamped on new items, and can filter an export.
3. **No accounting logic.** No categories, totals, charts, budgets, approvals, multi-user.
4. **Offload = CSV + zip of receipts**, then the user confirms "mark as exported". Never clear the
   pile without that confirmation.
5. Everything is local (IndexedDB). The UI nudges to offload when the oldest item is 3+ days old.

## Files
| File | Role |
|---|---|
| `index.html` | Markup. ids are wired to `app.js`; keep them. |
| `app.js` | UI + glue (capture, list, edit dialog, offload flow). |
| `db.js` | IndexedDB wrapper, one `items` store. Data shape documented at top. |
| `scan.js` | Reads receipts with the Claude API (user's own key): vendor, total, date, address, category. Runs in the background after capture. |
| `backup.js` | Google Drive backup/restore (`drive.file` scope; one JSON + one file per receipt). |
| `export.js` | CSV + store-only ZIP builder, receipt renaming (`2026-11-05_Vendor_312.44.jpg`). |
| `style.css` | **Placeholder styling — free to redesign.** |
| `service-worker.js` | Offline shell. Bump `CACHE` when shipping. |

No build step, no dependencies. Run locally: `python3 -m http.server 8765` then open
`http://localhost:8765`. For a phone, it must be served over HTTPS (e.g. GitHub Pages) and added
to the Home Screen.

## For the UI pass (Codex)
- Restyle `style.css`; change markup in `index.html` as needed, but keep element ids and the
  classes `app.js` creates (`item`, `thumb`, `item-body`, `item-title`, `item-meta`, `item-amount`).
- Keep: big one-tap Snap button, 44px+ touch targets, dark mode, safe-area padding.

## Hosting
GitHub Pages via `.github/workflows/pages.yml` (same as Quick Budget): push to `main` and it deploys.
The Google OAuth client is shared with Quick Budget; it works because the origin
`https://jordansloane-coder.github.io` is already authorized.

## Known limits / next
- **iOS Share Sheet target is not possible in a plain PWA.** Workaround today: "Add photos / PDFs"
  (pick from Photos/Files). To get "Share → On The Go" from Mail/Screenshots, wrap in Capacitor
  with a Share Extension.
- Backup is manual ("Back up now"); Google's token needs a tap, so there's no silent auto-backup yet.
- Possible later: dictated voice note attachment, OCR guess for amount/vendor.
