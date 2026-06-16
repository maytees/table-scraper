this entire repo is ai generated

# Table Scraper

A personal, unpacked Chrome extension that works like Instant Data Scraper — it detects repeating lists (not just `<table>` tags), auto-scrolls infinite feeds with random delays, and exports CSV — **plus** a multi-step mode: teach it one field inside a detail panel (e.g. the phone number on a Google Maps listing) and it will click through every row and grab that field.

## Files

- `manifest.json` — extension manifest (Manifest V3, `activeTab` only — no broad host permissions)
- `background.js` — injects the scraper into the current tab when you click the toolbar icon
- `scraper.js` — the whole app (panel UI, list detection, scrolling, element picker, detail click-through, CSV export)

## Install (one time)

1. Open Chrome and go to `chrome://extensions`
2. Turn on **Developer mode** (toggle, top-right corner)
3. Click **Load unpacked** and select this folder (`table-scraper`)
4. Optional: click the puzzle-piece icon in the toolbar and pin **Table Scraper**

That's it — no publishing, no account. The extension only runs on a tab after you click its icon there.

If you ever edit the code: go back to `chrome://extensions`, press the circular **reload** arrow on the Table Scraper card, then reload the web page tab.

## Usage — Google Maps walkthrough

1. Search Google Maps (e.g. _pet boarding hotel in Sydney_) so the results list is showing. Keep the browser window wide, so the list and the detail panel can be visible side by side.
2. Click the **Table Scraper** toolbar icon. The panel appears and auto-detects the biggest repeating list on the page — it gets a dashed blue outline. If it picked the wrong thing, press **Try another table** to cycle through candidates (the outline moves so you can see what's selected).
3. **Step 1 — collect the list.** Set _delay min/max_ (milliseconds; a random delay in that range is used between scrolls _and_ between detail clicks). Press **▶ Scroll & collect**. It scrolls the feed to the bottom, waits, collects new rows, and repeats until no new rows show up 3 times in a row (or you press Stop). Rows are deduplicated by their link, so nothing is double-counted. Untick **auto-scroll** if you'd rather scroll the list yourself — it then just keeps collecting whatever appears until you press Stop.
4. **Step 2 — teach the phone field.** Manually click any one listing so its detail panel opens. Press **＋ Pick detail field** — now hovering highlights elements on the page. Click the phone number. A name box appears (pre-filled by position: 1st field → `phone`, 2nd → `website`, then address/email/…) — press **Save**. Add more fields the same way and remove them with ✕. While the detail pass runs, a live line under the button shows exactly what it's doing per listing (clicking → waiting for panel → looking for your fields → ✓/— per field).
5. Press **▶ Click each row & grab**. It clicks every listing, waits for the panel to switch (re-clicking up to 3× if it doesn't open), then reads each field **only once the field is a new element or its value changed** — so it never grabs the previous listing's phone/website before Google repaints. Pauses by the **click delay** (its own input — default 250 ms). Progress bar + live "currently doing" line. **Stop** any time.
   - **Automatic retries:** after the first pass finishes it **automatically re-runs the empties-&-duplicates retry up to 3 times** (stops early once there's nothing left), so you don't have to. A duplicate phone/website across distinct listings usually means a stale grab — those rows are re-done too.
   - The **↻ Retry empties & dups (N)** button is still there if you want to run another retry by hand. Duplicate values are highlighted **light red** in the Preview.
6. **Step 3 — export.** Press **☰ Columns** to pick exactly what gets exported: every column is listed with a checkbox and a sample value, with **All / None / Auto** bulk buttons (Auto = back to automatic junk detection; separator columns like "·" start unchecked). **Preview** shows all collected rows with only the ticked columns. Then **⬇ Export CSV** (file download, UTF-8 BOM so Excel opens it correctly) or **⧉ Copy table** (tab-separated text to the clipboard — pastes into Google Sheets / Excel as real cells, not one blob of text).

## Notes & troubleshooting

- **Same-page details only.** The multi-step mode works when clicking a row opens the detail on the _same page_ (SPA-style, like Google Maps). If a site navigates to a whole new page per row, this flow can't work there.
- **Google Maps caps a search at ~120 results.** For bigger coverage, zoom into sub-areas and run separate searches, exporting each.
- **Speed of the detail pass.** It no longer uses the scroll delay between clicks — it waits for the listing panel to actually switch (detected by the Maps URL changing), then pauses by the **click delay** (default 250 ms, its own input next to the button) before reading. Listings missing the value are detected fast (~1 s) instead of stalling ~5 s. Lower the click delay for more speed; raise it if Google starts throwing captchas.
- **"Could not build a stable selector"** when picking: click a slightly different element — the text itself, or its parent block.
- **Panel gone after navigating?** Google Maps is a single-page app, so the panel survives clicking around. If you do a full page reload, just click the toolbar icon again.
- **Be polite.** Keep delays ≥ 800 ms. Hammering Google Maps can get you a captcha or temporary block. This is for personal use; respect the site's terms of service.
