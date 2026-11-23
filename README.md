# Viking Power Search

A Manifest V3 Chrome extension styled to match **Qantas Power Search** that saves multiple Viking Cruises Australia itineraries and finds the **earliest lowest-priced `PS3` (Penthouse Junior Suite)** departure date across all available years and both itinerary directions.

## Features
- **Paste or capture any Viking Cruises AU URL:** Supports `vikingcruises.com.au` itinerary or `pricing.html` URLs (plus a **Use Current Tab** button).
- **Lowest `PS3` fare lookup:** Scans all available sailings across every year and both route directions, excludes sold-out sailings, and returns the lowest `PS3` AUD fare.
- **Earliest-date tie-breaker:** When multiple dates share the lowest fare, displays the closest upcoming departure date and states *"Earliest of X dates at this price"*.
- **Direction recall:** Treats both directions as the same cruise while recalling and displaying the direction of the winning sailing (e.g., `Reykjavik → New York City, New York`).
- **Saved cruises synced via Google Account:** Saved cruise profiles are stored in `chrome.storage.sync` so they stay synced across your desktop Chrome browsers.

## Installation (Unpacked Extension)
1. Open `chrome://extensions/` in Google Chrome.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this `VikingPowerSearch` folder.
4. Pin **Viking Power Search** to your Chrome toolbar.

### Cross-Device Sync Note
`manifest.json` includes a fixed public `"key"` so Chrome assigns the same Extension ID on every computer where you load this folder unpacked—allowing `chrome.storage.sync` to sync your saved cruises automatically via your Google account (make sure **Extensions** is enabled in Chrome Sync settings).

*(If you ever publish to the Chrome Web Store, remove the `"key"` field from `manifest.json` first.)*

## Files
- `manifest.json` — Manifest V3 configuration, permissions, and fixed Extension ID key
- `popup.html` / `popup.css` / `popup.js` — Toolbar popup UI, saved cruise management, and result card
- `background.js` — Service worker fetching Viking Cruises' `DnPCruiseFullInfo` and `DnPSailingDetails` JSON endpoints
- `viking-parser.js` — URL normalization, HTML config extraction, `PS3` filtering, and lowest-price selection logic
- `icon128.png` — Extension icon
