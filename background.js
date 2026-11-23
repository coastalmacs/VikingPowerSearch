importScripts('viking-parser.js');

const CACHE_STORAGE_KEY = 'vikingResultCache';
const MAX_CONCURRENCY = 5;
const REQUEST_TIMEOUT_MS = 20000;
const PRUNE_THRESHOLD = 25;

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      credentials: 'include',
      signal: controller.signal
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function postVikingJson(url, payload) {
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json, text/javascript, */*; q=0.01'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Viking pricing API returned HTTP ${response.status}.`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('json')) {
    throw new Error('Unexpected response from Viking pricing service. Please check the URL.');
  }

  return response.json();
}

async function saveResultToCache(canonicalKey, result) {
  try {
    const stored = await chrome.storage.local.get([CACHE_STORAGE_KEY]);
    const cache = stored[CACHE_STORAGE_KEY] || {};
    cache[canonicalKey] = result;
    await chrome.storage.local.set({ [CACHE_STORAGE_KEY]: cache });
  } catch {
    // Non-fatal if cache storage fails
  }
}

async function searchLowestPS3(rawUrl) {
  const normalized = VikingParser.normalizeVikingUrl(rawUrl);
  if (!normalized.valid) {
    return {
      status: 'ERROR',
      message: normalized.error
    };
  }

  // 1. Fetch the pricing page HTML to get exact InitLoad params (cruiseId, workerRootPath, offerCode)
  let pageHtml = '';
  try {
    const pageResp = await fetchWithTimeout(normalized.pricingUrl, {
      method: 'GET',
      headers: {
        'Accept': 'text/html,application/xhtml+xml'
      }
    });
    if (!pageResp.ok) {
      throw new Error(`Could not load cruise pricing page (HTTP ${pageResp.status}).`);
    }
    pageHtml = await pageResp.text();
  } catch (err) {
    return {
      status: 'ERROR',
      pricingUrl: normalized.pricingUrl,
      canonicalKey: normalized.canonicalKey,
      message: err.name === 'AbortError'
        ? 'Timed out loading the Viking Cruises page.'
        : (err.message || 'Failed to load Viking Cruises pricing page.')
    };
  }

  const config = VikingParser.extractInitConfig(pageHtml, normalized);
  const baseApiUrl = `https://www.vikingcruises.com.au${config.workerRootPath}`;

  // 2. Fetch full sailing list across all years and both itinerary directions
  let fullInfo;
  try {
    fullInfo = await postVikingJson(
      `${baseApiUrl}/Core/DnPCruiseFullInfo?v=11`,
      {
        cruiseId: config.cruiseId,
        parameters: normalized.searchParams,
        offerCode: config.offerCode
      }
    );
  } catch (err) {
    return {
      status: 'ERROR',
      cruiseTitle: config.cruiseName,
      pricingUrl: normalized.pricingUrl,
      canonicalKey: normalized.canonicalKey,
      message: err.name === 'AbortError'
        ? 'Timed out fetching sailing dates from Viking.'
        : (err.message || 'Failed to fetch sailing dates from Viking.')
    };
  }

  const checkedAt = Date.now();
  const cruises = Array.isArray(fullInfo && fullInfo.cruises) ? fullInfo.cruises : [];
  const cruiseTitle = (cruises[0] && cruises[0].CruiseName)
    ? VikingParser.decodeHtmlEntities(cruises[0].CruiseName)
    : config.cruiseName;

  if (fullInfo && fullInfo.cruiseSoldOutFlag) {
    const res = {
      status: 'ALL_SOLD_OUT',
      cruiseTitle,
      pricingUrl: normalized.pricingUrl,
      canonicalKey: normalized.canonicalKey,
      checkedAt,
      message: 'All sailings for this cruise are currently sold out.'
    };
    await saveResultToCache(normalized.canonicalKey, res);
    return res;
  }

  if (!cruises.length || (fullInfo && fullInfo.cruiseErrorFlag)) {
    const res = {
      status: 'NO_SAILINGS',
      cruiseTitle,
      pricingUrl: normalized.pricingUrl,
      canonicalKey: normalized.canonicalKey,
      checkedAt,
      message: 'No pricing or departure dates are currently available for this cruise.'
    };
    await saveResultToCache(normalized.canonicalKey, res);
    return res;
  }

  const todayYmd = VikingParser.getTodayYmd();
  const suiteTypes = Array.isArray(fullInfo.suiteTypes) ? fullInfo.suiteTypes : [];

  const upcomingSailings = cruises
    .map((sailing) => ({
      sailing,
      date: VikingParser.parseDepartureDate(sailing),
      suiteLowerBound: VikingParser.getSuiteLowerBound(sailing)
    }))
    .filter((entry) => entry.date && entry.date.ymd >= todayYmd);

  const candidates = upcomingSailings
    .filter((entry) => VikingParser.isSailingCandidateForPS3(entry.sailing, suiteTypes))
    .sort((a, b) => {
      const aBound = a.suiteLowerBound !== null ? a.suiteLowerBound : Infinity;
      const bBound = b.suiteLowerBound !== null ? b.suiteLowerBound : Infinity;
      if (aBound !== bBound) return aBound - bBound;
      return a.date.ymd - b.date.ymd;
    });

  // If no candidates have suites available, probe one sailing to see whether PS3 is offered at all
  if (candidates.length === 0) {
    let sawPS3 = false;
    const probe = upcomingSailings[0] || (cruises[0] ? { sailing: cruises[0] } : null);
    if (probe && probe.sailing && probe.sailing.sailingKey) {
      try {
        const detail = await postVikingJson(
          `${baseApiUrl}/Core/DnPSailingDetails?v=11`,
          {
            cruiseId: config.cruiseId,
            cruiseName: cruiseTitle,
            sailingKey: probe.sailing.sailingKey,
            itineraryTcm: probe.sailing.itineraryTcm || '',
            offerCode: probe.sailing.TacticalCode || config.offerCode,
            parameters: normalized.searchParams
          }
        );
        sawPS3 = VikingParser.extractPS3FromSailingDetails(detail).exists;
      } catch {
        // Ignore probe failure
      }
    }

    const res = sawPS3
      ? {
          status: 'ALL_SOLD_OUT',
          cruiseTitle,
          pricingUrl: normalized.pricingUrl,
          canonicalKey: normalized.canonicalKey,
          checkedAt,
          message: 'No available PS3 cabins found (all dates sold out).'
        }
      : {
          status: 'PS3_NOT_OFFERED',
          cruiseTitle,
          pricingUrl: normalized.pricingUrl,
          canonicalKey: normalized.canonicalKey,
          checkedAt,
          message: 'PS3 category is not offered on this cruise.'
        };
    await saveResultToCache(normalized.canonicalKey, res);
    return res;
  }

  // 3. Query DnPSailingDetails with bounded concurrency across candidate sailings
  const matches = [];
  let sawPS3Category = false;
  let bestAvailablePrice = Infinity;
  let nextIndex = 0;
  const allowPrune = candidates.length > PRUNE_THRESHOLD;

  async function worker() {
    while (nextIndex < candidates.length) {
      const current = candidates[nextIndex++];
      if (
        allowPrune &&
        bestAvailablePrice < Infinity &&
        current.suiteLowerBound !== null &&
        current.suiteLowerBound > bestAvailablePrice
      ) {
        continue;
      }

      const s = current.sailing;
      try {
        const detail = await postVikingJson(
          `${baseApiUrl}/Core/DnPSailingDetails?v=11`,
          {
            cruiseId: config.cruiseId,
            cruiseName: cruiseTitle,
            sailingKey: s.sailingKey,
            itineraryTcm: s.itineraryTcm || '',
            offerCode: s.TacticalCode || config.offerCode,
            parameters: normalized.searchParams
          }
        );

        const ps3 = VikingParser.extractPS3FromSailingDetails(detail);
        if (ps3.exists) {
          sawPS3Category = true;
          if (ps3.available && ps3.price < bestAvailablePrice) {
            bestAvailablePrice = ps3.price;
          }
          matches.push({
            available: ps3.available,
            price: ps3.price,
            priceFormatted: ps3.priceFormatted,
            availLabel: ps3.availLabel,
            suiteName: ps3.suiteName,
            date: current.date,
            direction: VikingParser.formatDirection(s.cruiseDirection),
            rawDirection: s.cruiseDirection || '',
            cruiseDurationWithYear: s.cruiseDurationWithYear || '',
            shipName: (detail && detail.sailingData && detail.sailingData.cruiseShip && detail.sailingData.cruiseShip.name)
              || s.shipType
              || '',
            packageCode: s.PackageCode || ''
          });
        }
      } catch {
        // Skip individual failed sailing detail without aborting the entire scan
      }
    }
  }

  const workers = [];
  const workerCount = Math.min(MAX_CONCURRENCY, candidates.length);
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  const selection = VikingParser.selectLowestPS3Winner(matches, todayYmd);

  if (!selection) {
    const res = sawPS3Category
      ? {
          status: 'ALL_SOLD_OUT',
          cruiseTitle,
          pricingUrl: normalized.pricingUrl,
          canonicalKey: normalized.canonicalKey,
          checkedAt,
          message: 'No available PS3 cabins found (all dates sold out).'
        }
      : {
          status: 'PS3_NOT_OFFERED',
          cruiseTitle,
          pricingUrl: normalized.pricingUrl,
          canonicalKey: normalized.canonicalKey,
          checkedAt,
          message: 'PS3 category is not offered on this cruise.'
        };
    await saveResultToCache(normalized.canonicalKey, res);
    return res;
  }

  const winner = selection.winner;
  const result = {
    status: 'OK',
    cruiseTitle,
    pricingUrl: normalized.pricingUrl,
    canonicalKey: normalized.canonicalKey,
    lowestPrice: winner.price,
    lowestPriceFormatted: winner.priceFormatted,
    departureDateFormatted: winner.date.formatted,
    departureDateIso: winner.date.iso,
    cruiseDurationWithYear: winner.cruiseDurationWithYear,
    direction: winner.direction,
    shipName: winner.shipName,
    availLabel: winner.availLabel,
    packageCode: winner.packageCode,
    tieCount: selection.tieCount,
    availablePS3Count: selection.availablePS3Count,
    totalSailings: upcomingSailings.length,
    checkedAt
  };

  await saveResultToCache(normalized.canonicalKey, result);
  return result;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === 'SEARCH_PS3') {
    searchLowestPS3(message.url)
      .then((res) => sendResponse(res))
      .catch((err) => {
        sendResponse({
          status: 'ERROR',
          message: err && err.message ? err.message : 'Unexpected error while searching.'
        });
      });
    return true;
  }
});
