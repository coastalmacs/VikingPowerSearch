(function (root) {
  'use strict';

  const ALLOWED_HOSTS = new Set([
    'www.vikingcruises.com.au',
    'vikingcruises.com.au'
  ]);

  const MONTH_NAMES_SHORT = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
  ];

  function decodeHtmlEntities(str) {
    if (!str || typeof str !== 'string') return '';
    return str
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function titleCaseSlug(slug) {
    if (!slug) return '';
    return slug
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (ch) => ch.toUpperCase())
      .trim();
  }

  function normalizeVikingUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) {
      return { valid: false, error: 'Please paste a Viking Cruises Australia URL.' };
    }

    let candidate = rawUrl.trim();
    if (!/^https?:\/\//i.test(candidate)) {
      candidate = 'https://' + candidate;
    }

    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      return { valid: false, error: 'Invalid URL format.' };
    }

    const hostLower = parsed.hostname.toLowerCase();
    if (!ALLOWED_HOSTS.has(hostLower)) {
      return {
        valid: false,
        error: 'URL must be from www.vikingcruises.com.au.'
      };
    }

    const rawPath = parsed.pathname.replace(/\/+/g, '/');
    const segments = rawPath.split('/').filter(Boolean);

    if (segments.length < 2) {
      return {
        valid: false,
        error: 'Please paste a specific Viking cruise itinerary or pricing URL.'
      };
    }

    const workerRootPath = '/' + segments[0].toLowerCase();
    let baseSegments = segments.slice();
    const lastSeg = baseSegments[baseSegments.length - 1];

    if (/\.html?$/i.test(lastSeg)) {
      baseSegments.pop();
    }

    if (baseSegments.length < 2) {
      return {
        valid: false,
        error: 'Could not identify a cruise itinerary in this URL.'
      };
    }

    const fallbackSlug = baseSegments[baseSegments.length - 1];
    const pricingPath = '/' + baseSegments.join('/') + '/pricing.html';
    const pricingUrl = 'https://www.vikingcruises.com.au' + pricingPath + (parsed.search || '');
    const canonicalKey = ('https://www.vikingcruises.com.au' + pricingPath).toLowerCase();

    return {
      valid: true,
      pricingUrl,
      canonicalKey,
      workerRootPath,
      fallbackSlug,
      searchParams: parsed.search || ''
    };
  }

  function extractInitConfig(html, normalized) {
    let workerRootPath = normalized.workerRootPath || '/oceans';
    let cruiseId = normalized.fallbackSlug || '';
    let offerCode = 'EBS';
    let cruiseName = '';

    if (typeof html === 'string' && html.length > 0) {
      const rootMatch = html.match(/var\s+workerRootPath\s*=\s*['"]([^'"]+)['"]/i);
      if (rootMatch && rootMatch[1]) {
        workerRootPath = rootMatch[1].trim();
      }

      // DnPCore.InitLoad('cruiseId', 'phone', { ... }, 'offerCode', 'cruiseName')
      const initMatch = html.match(
        /DnPCore\.InitLoad\(\s*(['"])([^'"]+)\1\s*,\s*(['"])[^'"]*\3\s*,\s*\{[\s\S]*?\}\s*,\s*(['"])([^'"]*)\4\s*,\s*(['"])((?:\\.|[^\\])*?)\6\s*\)/
      );

      if (initMatch) {
        cruiseId = decodeHtmlEntities(initMatch[2]);
        offerCode = decodeHtmlEntities(initMatch[5]) || 'EBS';
        cruiseName = decodeHtmlEntities(initMatch[7].replace(/\\(['"])/g, '$1'));
      } else {
        // Fallback: grab first argument to InitLoad if signature changed slightly
        const simpleInitMatch = html.match(/DnPCore\.InitLoad\(\s*(['"])([^'"]+)\1/);
        if (simpleInitMatch && simpleInitMatch[2]) {
          cruiseId = decodeHtmlEntities(simpleInitMatch[2]);
        }
      }

      if (!cruiseName) {
        const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        if (titleMatch && titleMatch[1]) {
          cruiseName = decodeHtmlEntities(titleMatch[1])
            .replace(/\s*[-–|]\s*\d{4}\s+Dates\s*&\s*Pricing.*$/i, '')
            .replace(/\s*\|\s*Viking.*$/i, '')
            .trim();
        }
      }
    }

    if (!cruiseName) {
      cruiseName = titleCaseSlug(cruiseId);
    }

    return {
      workerRootPath,
      cruiseId,
      offerCode,
      cruiseName
    };
  }

  function parsePriceAud(value) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.round(value);
    }
    if (typeof value !== 'string') return null;
    const cleaned = value.replace(/[^0-9.]/g, '');
    if (!cleaned) return null;
    const parsed = parseFloat(cleaned);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.round(parsed);
  }

  function formatPriceAud(amount) {
    if (typeof amount !== 'number' || !Number.isFinite(amount)) return '';
    return 'AU$' + Math.round(amount).toLocaleString('en-AU');
  }

  function getTodayYmd(dateObj) {
    const d = dateObj instanceof Date ? dateObj : new Date();
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const day = d.getDate();
    return y * 10000 + m * 100 + day;
  }

  function parseDepartureDate(sailing) {
    if (!sailing) return null;

    let year = null;
    let month = null;
    let day = null;

    if (typeof sailing.DepartureDateString === 'string' && /^\d{8}$/.test(sailing.DepartureDateString)) {
      year = parseInt(sailing.DepartureDateString.slice(0, 4), 10);
      month = parseInt(sailing.DepartureDateString.slice(4, 6), 10);
      day = parseInt(sailing.DepartureDateString.slice(6, 8), 10);
    } else if (sailing.cruiseYearNumber && sailing.cruiseMonthNumber && sailing.cruiseDayNumber) {
      year = parseInt(sailing.cruiseYearNumber, 10);
      month = parseInt(sailing.cruiseMonthNumber, 10);
      day = parseInt(sailing.cruiseDayNumber, 10);
    }

    if (!year || !month || !day || month < 1 || month > 12 || day < 1 || day > 31) {
      return null;
    }

    const mm = String(month).padStart(2, '0');
    const dd = String(day).padStart(2, '0');

    return {
      year,
      month,
      day,
      ymd: year * 10000 + month * 100 + day,
      iso: `${year}-${mm}-${dd}`,
      formatted: `${day} ${MONTH_NAMES_SHORT[month - 1]} ${year}`
    };
  }

  function formatDirection(rawDirection) {
    if (!rawDirection || typeof rawDirection !== 'string') return 'Not specified';
    const cleaned = decodeHtmlEntities(rawDirection);
    return cleaned.replace(/\s+to\s+/i, ' \u2192 ');
  }

  function getSuiteLowerBound(sailing) {
    if (!sailing || !Array.isArray(sailing.stateroomSummary)) return null;
    const suiteEntry = sailing.stateroomSummary.find(
      (item) => item && typeof item.typeName === 'string' && /suite/i.test(item.typeName)
    );
    if (!suiteEntry) return null;
    return parsePriceAud(suiteEntry.lowestCruisePrice ?? suiteEntry.priceRange);
  }

  function isSailingCandidateForPS3(sailing, cruiseSuiteTypes) {
    if (!sailing || sailing.soldOut === true) return false;

    const cruiseHasSuiteType =
      Array.isArray(cruiseSuiteTypes) &&
      cruiseSuiteTypes.some((t) => typeof t === 'string' && /suite/i.test(t));

    if (cruiseHasSuiteType && Array.isArray(sailing.availableSuiteTypes)) {
      const hasSuite = sailing.availableSuiteTypes.some(
        (t) => typeof t === 'string' && /suite/i.test(t)
      );
      if (!hasSuite) return false;
    }

    return true;
  }

  function extractPS3FromSailingDetails(detailResponse) {
    const suites = detailResponse &&
      detailResponse.sailingData &&
      Array.isArray(detailResponse.sailingData.cruiseSuites)
      ? detailResponse.sailingData.cruiseSuites
      : [];

    const ps3 = suites.find((suite) => {
      if (!suite) return false;
      const cat = typeof suite.stateroomCategory === 'string'
        ? suite.stateroomCategory.trim().toUpperCase()
        : '';
      if (cat === 'PS3') return true;
      const name = typeof suite.suiteName === 'string' ? suite.suiteName : '';
      return /\(PS3\)/i.test(name);
    });

    if (!ps3) {
      return { exists: false, available: false };
    }

    const availLabel = decodeHtmlEntities(ps3.availLabel || '');
    const unavailableLabel = /sold\s*out|waitlist|unavailable|not\s*available/i.test(availLabel);
    const price = parsePriceAud(ps3.discountedPrice) ?? parsePriceAud(ps3.originalPrice);
    const available = !ps3.soldOut && !unavailableLabel && price !== null;

    return {
      exists: true,
      available,
      price,
      priceFormatted: price !== null
        ? (decodeHtmlEntities(ps3.discountedPrice || '') || formatPriceAud(price))
        : '',
      availLabel: availLabel || (available ? 'Available' : 'Sold Out'),
      suiteName: decodeHtmlEntities(ps3.suiteName || 'Penthouse Junior Suite (PS3)'),
      stateroomDeal: decodeHtmlEntities(ps3.stateroomDeal || '')
    };
  }

  function selectLowestPS3Winner(matches, nowYmd) {
    const cutoffYmd = typeof nowYmd === 'number' ? nowYmd : getTodayYmd();

    const eligible = (matches || []).filter(
      (m) => m && m.available && typeof m.price === 'number' && m.price > 0 && m.date && m.date.ymd >= cutoffYmd
    );

    if (eligible.length === 0) {
      return null;
    }

    let minPrice = Infinity;
    for (const item of eligible) {
      if (item.price < minPrice) {
        minPrice = item.price;
      }
    }

    const tied = eligible
      .filter((item) => item.price === minPrice)
      .sort((a, b) => {
        if (a.date.ymd !== b.date.ymd) return a.date.ymd - b.date.ymd;
        return String(a.packageCode || '').localeCompare(String(b.packageCode || ''));
      });

    return {
      winner: tied[0],
      tieCount: tied.length,
      availablePS3Count: eligible.length
    };
  }

  const api = {
    decodeHtmlEntities,
    normalizeVikingUrl,
    extractInitConfig,
    parsePriceAud,
    formatPriceAud,
    getTodayYmd,
    parseDepartureDate,
    formatDirection,
    getSuiteLowerBound,
    isSailingCandidateForPS3,
    extractPS3FromSailingDetails,
    selectLowestPS3Winner
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.VikingParser = api;
  }
})(typeof self !== 'undefined' ? self : this);
