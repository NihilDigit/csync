// Pure utilities shared by background service worker, popup, and unit tests

export const MAX_LS_VALUE_BYTES = 256 * 1024;
export const MAX_LS_ORIGIN_BYTES = 2 * 1024 * 1024;

export function normalizeHost(host) {
  if (typeof host !== 'string') return '';
  const trimmed = host.trim().toLowerCase();
  return trimmed.startsWith('.') ? trimmed.slice(1) : trimmed;
}

/**
 * Strict domain matching: targetHost equals configuredSite or is a subdomain of it.
 * Never guesses 2-label root domains (avoids foo.co.uk matching bar.co.uk)
 * and never reverse-matches parent domains against a narrower subdomain rule.
 */
export function hostMatchesSite(targetHost, configuredSite) {
  const host = normalizeHost(targetHost);
  const site = normalizeHost(configuredSite);
  if (!host || !site) return false;
  return host === site || host.endsWith('.' + site);
}

/**
 * Cookie domain matching: a cookie on `.example.com` applies to `app.example.com`,
 * and a cookie on `app.example.com` applies when `example.com` is configured.
 */
export function cookieDomainMatchesSite(cookieDomain, configuredSite) {
  const cookieHost = normalizeHost(cookieDomain);
  const site = normalizeHost(configuredSite);
  if (!cookieHost || !site) return false;
  return (
    cookieHost === site ||
    cookieHost.endsWith('.' + site) ||
    site.endsWith('.' + cookieHost)
  );
}

export function findMatchingSite(hostname, websites) {
  if (!hostname || !Array.isArray(websites)) return null;
  const normalized = normalizeHost(hostname);
  // Prefer most specific rule when both root and subdomain exist
  let best = null;
  for (const site of websites) {
    if (hostMatchesSite(normalized, site)) {
      if (!best || site.length > best.length) {
        best = site;
      }
    }
  }
  return best;
}

export function findMatchingSiteForCookie(cookieDomain, websites) {
  if (!cookieDomain || !Array.isArray(websites)) return null;
  let best = null;
  for (const site of websites) {
    if (cookieDomainMatchesSite(cookieDomain, site)) {
      if (!best || site.length > best.length) {
        best = site;
      }
    }
  }
  return best;
}

export function isSyncableUrl(urlString) {
  if (!urlString) return false;
  try {
    const url = new URL(urlString);
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export function buildMatchPatterns(websites) {
  const patterns = new Set();
  for (const raw of websites || []) {
    const host = normalizeHost(raw);
    if (!host) continue;
    const isIpOrSingleLabel =
      !host.includes('.') ||
      /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
      host.includes(':');
    if (isIpOrSingleLabel) {
      patterns.add(`*://${host}/*`);
    } else {
      // Chrome match pattern `*://*.example.com/*` covers both apex and all subdomains
      patterns.add(`*://*.${host}/*`);
    }
  }
  return Array.from(patterns);
}

export function buildCookieUrl(cookie) {
  const cleanDomain = normalizeHost(cookie.domain);
  const needsHttps =
    Boolean(cookie.secure) ||
    cookie.name.startsWith('__Secure-') ||
    cookie.name.startsWith('__Host-');
  const scheme = needsHttps ? 'https' : 'http';
  const path = cookie.path && cookie.path.startsWith('/') ? cookie.path : '/';
  return `${scheme}://${cleanDomain}${path}`;
}

export function buildCookieSetDetails(cookie, storeId) {
  const isHostPrefix = cookie.name.startsWith('__Host-');
  const details = {
    url: buildCookieUrl(cookie),
    name: cookie.name,
    value: cookie.value,
    path: isHostPrefix ? '/' : (cookie.path || '/'),
    secure: isHostPrefix || cookie.name.startsWith('__Secure-') ? true : Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    storeId
  };

  if (!cookie.hostOnly && !isHostPrefix) {
    details.domain = cookie.domain;
  }

  if (cookie.sameSite && cookie.sameSite !== 'unspecified') {
    details.sameSite = cookie.sameSite;
    if (cookie.sameSite === 'no_restriction') {
      details.secure = true;
    }
  }

  if (typeof cookie.expirationDate === 'number') {
    details.expirationDate = cookie.expirationDate;
  }

  if (cookie.partitionKey) {
    details.partitionKey = cookie.partitionKey;
  }

  return details;
}

export function buildCookieRemoveDetails(cookie, storeId) {
  const details = {
    url: buildCookieUrl(cookie),
    name: cookie.name,
    storeId
  };
  if (cookie.partitionKey) {
    details.partitionKey = cookie.partitionKey;
  }
  return details;
}

export function filterLocalStorageItems(items) {
  if (!Array.isArray(items)) return [];
  const filtered = [];
  let totalBytes = 0;
  for (const item of items) {
    if (!item || typeof item.key !== 'string' || !item.key) continue;
    const value = typeof item.value === 'string' ? item.value : '';
    const entryBytes = (item.key.length + value.length) * 2;
    if (entryBytes > MAX_LS_VALUE_BYTES) continue;
    if (totalBytes + entryBytes > MAX_LS_ORIGIN_BYTES) break;
    filtered.push({ key: item.key, value });
    totalBytes += entryBytes;
  }
  return filtered;
}

export function localStorageSessionKey(origin) {
  return `csync_ls_${origin}`;
}
