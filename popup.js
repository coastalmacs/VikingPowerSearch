const SYNC_KEY = 'vikingCruiseProfiles';
const CACHE_KEY = 'vikingResultCache';

let profiles = {};
let activeSearchId = 0;

function renderProfileDropdown(loadedProfiles, selectedName = '') {
    profiles = loadedProfiles || {};
    const select = document.getElementById('profileSelect');
    const previousSelection = selectedName || select.value;

    select.innerHTML = '<option value="">-- New --</option>';

    Object.keys(profiles)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
        .forEach((name) => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            select.appendChild(opt);
        });

    if (previousSelection && profiles[previousSelection]) {
        select.value = previousSelection;
        document.getElementById('deleteBtn').disabled = false;
    } else {
        select.value = '';
        document.getElementById('deleteBtn').disabled = true;
    }
}

// Load saved cruises from chrome.storage.sync (synced across Chrome via Google account)
// with automatic migration fallback from local storage, matching QantasPowerSearch.
function loadProfiles(selectedName = '') {
    chrome.storage.sync.get([SYNC_KEY], (result) => {
        if (result[SYNC_KEY] && Object.keys(result[SYNC_KEY]).length > 0) {
            renderProfileDropdown(result[SYNC_KEY], selectedName);
        } else {
            chrome.storage.local.get([SYNC_KEY], (localResult) => {
                if (localResult[SYNC_KEY] && Object.keys(localResult[SYNC_KEY]).length > 0) {
                    chrome.storage.sync.set({ [SYNC_KEY]: localResult[SYNC_KEY] });
                    renderProfileDropdown(localResult[SYNC_KEY], selectedName);
                } else {
                    renderProfileDropdown({}, selectedName);
                }
            });
        }
    });
}

function formatCheckedAt(timestamp) {
    if (!timestamp) return '';
    const d = new Date(timestamp);
    const now = new Date();
    const isToday =
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate();

    const timeStr = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (isToday) return `Today ${timeStr}`;
    const dateStr = d.toLocaleDateString([], { day: 'numeric', month: 'short' });
    return `${dateStr} ${timeStr}`;
}

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function setSearchButtonBusy(isBusy) {
    const btn = document.getElementById('searchBtn');
    btn.disabled = isBusy;
    btn.textContent = isBusy ? 'Searching...' : 'Search';
}

function hideResultCard() {
    const card = document.getElementById('resultCard');
    card.className = 'result-card hidden';
    card.innerHTML = '';
}

function renderLoading(message = 'Checking PS3 fares across all dates...') {
    const card = document.getElementById('resultCard');
    card.className = 'result-card';
    card.innerHTML = `
        <div class="loading-row">
            <div class="spinner"></div>
            <span>${escapeHtml(message)}</span>
        </div>
    `;
}

function attachCardActions(url) {
    const openBtn = document.getElementById('openVikingBtn');
    if (openBtn && url) {
        openBtn.addEventListener('click', () => {
            chrome.tabs.create({ url });
        });
    }

    const refreshBtn = document.getElementById('refreshResultBtn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            const currentUrl = document.getElementById('cruiseUrl').value.trim() || url;
            if (currentUrl) {
                runSearch(currentUrl, { showCachedFirst: false });
            }
        });
    }
}

function renderResult(res, options = {}) {
    const card = document.getElementById('resultCard');
    const isUpdating = Boolean(options.isUpdating);

    if (!res) {
        hideResultCard();
        return;
    }

    if (res.status === 'OK') {
        const tieCount = typeof res.tieCount === 'number' && res.tieCount > 0 ? res.tieCount : 1;
        const tieText = `Earliest of ${tieCount} ${tieCount === 1 ? 'date' : 'dates'} at this price`;

        const voyageParts = [];
        if (res.cruiseDurationWithYear) voyageParts.push(res.cruiseDurationWithYear);
        if (res.shipName) voyageParts.push(res.shipName);

        const openUrl = res.packageCode
            ? `${res.pricingUrl}${res.pricingUrl.includes('?') ? '&' : '?'}voyageId=${encodeURIComponent(res.packageCode)}`
            : res.pricingUrl;

        card.className = 'result-card';
        card.innerHTML = `
            <div class="result-header">
                <div class="result-title">${escapeHtml(res.cruiseTitle)}</div>
                <span class="cabin-badge">PS3</span>
            </div>
            <div class="result-price-row">
                <span class="result-price">${escapeHtml(res.lowestPriceFormatted)}</span>
                <span class="result-pp">per person</span>
            </div>
            <div class="result-date">${escapeHtml(res.departureDateFormatted)}</div>
            <div class="result-tie">${escapeHtml(tieText)}</div>
            <div class="result-meta">
                <div><span class="result-meta-label">Direction:</span> ${escapeHtml(res.direction)}</div>
                ${voyageParts.length ? `<div><span class="result-meta-label">Voyage:</span> ${escapeHtml(voyageParts.join(' · '))}</div>` : ''}
                ${res.availLabel ? `<div><span class="result-meta-label">Availability:</span> ${escapeHtml(res.availLabel)}</div>` : ''}
            </div>
            <div class="result-footer">
                <span>${isUpdating ? '<span class="updating-tag">Updating live fares...</span>' : `Checked: ${escapeHtml(formatCheckedAt(res.checkedAt))}`}</span>
                <div class="result-actions">
                    <button type="button" id="refreshResultBtn" class="link-btn">Refresh</button>
                    <button type="button" id="openVikingBtn" class="link-btn">Open ↗</button>
                </div>
            </div>
        `;
        attachCardActions(openUrl);
        return;
    }

    const isError = res.status === 'ERROR';
    card.className = `result-card ${isError ? 'is-error' : 'is-muted'}`;
    card.innerHTML = `
        ${res.cruiseTitle ? `<div class="result-header"><div class="result-title">${escapeHtml(res.cruiseTitle)}</div><span class="cabin-badge">PS3</span></div>` : ''}
        <div class="status-message">${escapeHtml(res.message || 'Unable to retrieve PS3 fares.')}</div>
        <div class="result-footer">
            <span>${isUpdating ? '<span class="updating-tag">Updating live fares...</span>' : (res.checkedAt ? `Checked: ${escapeHtml(formatCheckedAt(res.checkedAt))}` : '')}</span>
            <div class="result-actions">
                <button type="button" id="refreshResultBtn" class="link-btn">Retry</button>
                ${res.pricingUrl ? '<button type="button" id="openVikingBtn" class="link-btn">Open ↗</button>' : ''}
            </div>
        </div>
    `;
    attachCardActions(res.pricingUrl);
}

async function getCachedResult(rawUrl) {
    const normalized = VikingParser.normalizeVikingUrl(rawUrl);
    if (!normalized.valid) return null;
    try {
        const stored = await chrome.storage.local.get([CACHE_KEY]);
        const cache = stored[CACHE_KEY] || {};
        return cache[normalized.canonicalKey] || null;
    } catch {
        return null;
    }
}

async function runSearch(rawUrl, options = { showCachedFirst: false }) {
    const trimmed = (rawUrl || '').trim();
    const normalized = VikingParser.normalizeVikingUrl(trimmed);

    if (!normalized.valid) {
        renderResult({ status: 'ERROR', message: normalized.error });
        return;
    }

    const searchId = ++activeSearchId;
    setSearchButtonBusy(true);

    let showedCache = false;
    if (options.showCachedFirst) {
        const cached = await getCachedResult(trimmed);
        if (searchId !== activeSearchId) return;
        if (cached) {
            renderResult(cached, { isUpdating: true });
            showedCache = true;
        }
    }

    if (!showedCache) {
        renderLoading('Checking PS3 fares across all dates...');
    }

    chrome.runtime.sendMessage({ type: 'SEARCH_PS3', url: normalized.pricingUrl }, (response) => {
        if (searchId !== activeSearchId) return;
        setSearchButtonBusy(false);

        if (chrome.runtime.lastError) {
            renderResult({
                status: 'ERROR',
                pricingUrl: normalized.pricingUrl,
                message: chrome.runtime.lastError.message || 'Extension communication error.'
            });
            return;
        }

        // Auto-suggest cruise title in "Save As" if user hasn't typed one yet
        const nameInput = document.getElementById('profileName');
        if (response && response.cruiseTitle && !nameInput.value.trim()) {
            nameInput.value = response.cruiseTitle;
        }

        renderResult(response);
    });
}

function flashButton(btn, text, color, resetColor, durationMs = 1800) {
    const originalText = btn.textContent;
    btn.textContent = text;
    btn.style.backgroundColor = color;
    setTimeout(() => {
        btn.textContent = originalText;
        btn.style.backgroundColor = resetColor;
    }, durationMs);
}

document.addEventListener('DOMContentLoaded', () => {
    loadProfiles();

    // Keep saved cruises synced if updated from another Chrome browser
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'sync' && changes[SYNC_KEY]) {
            renderProfileDropdown(changes[SYNC_KEY].newValue || {});
        }
    });

    // Profile selection -> populate fields and immediately search lowest PS3 date
    document.getElementById('profileSelect').addEventListener('change', (e) => {
        const name = e.target.value;
        const deleteBtn = document.getElementById('deleteBtn');

        if (name && profiles[name]) {
            const data = profiles[name];
            document.getElementById('profileName').value = name;
            document.getElementById('cruiseUrl').value = data.url || '';
            deleteBtn.disabled = false;

            if (data.url) {
                runSearch(data.url, { showCachedFirst: true });
            }
        } else {
            activeSearchId++;
            setSearchButtonBusy(false);
            document.getElementById('profileName').value = '';
            document.getElementById('cruiseUrl').value = '';
            deleteBtn.disabled = true;
            hideResultCard();
        }
    });

    // Use Current Tab shortcut
    document.getElementById('useTabBtn').addEventListener('click', () => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const tab = tabs && tabs[0];
            if (!tab || !tab.url) return;

            const normalized = VikingParser.normalizeVikingUrl(tab.url);
            if (!normalized.valid) {
                renderResult({
                    status: 'ERROR',
                    message: 'Current tab is not a Viking Cruises Australia itinerary page.'
                });
                return;
            }

            document.getElementById('cruiseUrl').value = normalized.pricingUrl;
            const nameInput = document.getElementById('profileName');
            if (!nameInput.value.trim() && tab.title) {
                const cleanTitle = tab.title
                    .replace(/\s*[-–|]\s*\d{4}\s+Dates\s*&\s*Pricing.*$/i, '')
                    .replace(/\s*\|\s*Viking.*$/i, '')
                    .trim();
                if (cleanTitle) nameInput.value = cleanTitle;
            }
            runSearch(normalized.pricingUrl, { showCachedFirst: true });
        });
    });

    // Save cruise profile to chrome.storage.sync
    document.getElementById('saveBtn').addEventListener('click', (e) => {
        const btn = e.target;
        const nameInput = document.getElementById('profileName');
        const urlInput = document.getElementById('cruiseUrl');
        const rawUrl = urlInput.value.trim();

        const normalized = VikingParser.normalizeVikingUrl(rawUrl);
        if (!normalized.valid) {
            flashButton(btn, 'Bad URL!', '#dc3545', '#333', 2000);
            renderResult({ status: 'ERROR', message: normalized.error });
            return;
        }

        let name = nameInput.value.trim();
        if (!name) {
            flashButton(btn, 'Enter a name!', '#dc3545', '#333', 2000);
            nameInput.focus();
            return;
        }

        urlInput.value = normalized.pricingUrl;

        profiles[name] = {
            url: normalized.pricingUrl,
            updatedAt: Date.now()
        };

        chrome.storage.sync.set({ [SYNC_KEY]: profiles }, () => {
            if (chrome.runtime.lastError) {
                flashButton(btn, 'Sync Error!', '#dc3545', '#333', 2000);
                return;
            }

            flashButton(btn, 'Saved!', '#28a745', '#333', 1800);
            loadProfiles(name);
        });
    });

    // Delete saved cruise profile
    document.getElementById('deleteBtn').addEventListener('click', (e) => {
        const name = document.getElementById('profileSelect').value;
        if (!name || !profiles[name]) return;

        const btn = e.target;
        delete profiles[name];

        chrome.storage.sync.set({ [SYNC_KEY]: profiles }, () => {
            flashButton(btn, 'Deleted!', '#dc3545', '', 1000);

            const select = document.getElementById('profileSelect');
            select.value = '';
            select.dispatchEvent(new Event('change'));
            loadProfiles();
        });
    });

    // Manual Search button
    document.getElementById('searchBtn').addEventListener('click', () => {
        const rawUrl = document.getElementById('cruiseUrl').value.trim();
        runSearch(rawUrl, { showCachedFirst: false });
    });

    // Enter key in Cruise URL triggers Search
    document.getElementById('cruiseUrl').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            runSearch(e.target.value.trim(), { showCachedFirst: false });
        }
    });
});
