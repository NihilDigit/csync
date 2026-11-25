import { describe, expect, test } from 'bun:test';
import {
  buildCookieRemoveDetails,
  buildCookieSetDetails,
  buildCookieUrl,
  buildMatchPatterns,
  cookieDomainMatchesSite,
  filterLocalStorageItems,
  findMatchingSite,
  findMatchingSiteForCookie,
  hostMatchesSite,
  isSyncableUrl,
  MAX_LS_VALUE_BYTES,
  normalizeHost
} from '../sync-utils.js';

describe('domain matching', () => {
  test('normalizes leading dots, case, and whitespace', () => {
    expect(normalizeHost(' .Example.COM ')).toBe('example.com');
    expect(normalizeHost('')).toBe('');
  });

  test('hostMatchesSite supports exact and subdomain matches without reverse or public-suffix leaks', () => {
    expect(hostMatchesSite('example.com', 'example.com')).toBe(true);
    expect(hostMatchesSite('www.example.com', 'example.com')).toBe(true);
    expect(hostMatchesSite('a.b.example.com', 'example.com')).toBe(true);
    // Must not reverse-match parent domain against narrower subdomain rule
    expect(hostMatchesSite('example.com', 'app.example.com')).toBe(false);
    // Must not falsely match sibling sites on multi-level public suffixes
    expect(hostMatchesSite('foo.co.uk', 'bar.co.uk')).toBe(false);
    expect(hostMatchesSite('a.github.io', 'b.github.io')).toBe(false);
    expect(hostMatchesSite('notexample.com', 'example.com')).toBe(false);
  });

  test('cookieDomainMatchesSite handles parent cookies for subdomain rules', () => {
    expect(cookieDomainMatchesSite('.example.com', 'app.example.com')).toBe(true);
    expect(cookieDomainMatchesSite('app.example.com', 'example.com')).toBe(true);
    expect(cookieDomainMatchesSite('.foo.co.uk', 'bar.co.uk')).toBe(false);
  });

  test('findMatchingSite picks the most specific matching rule', () => {
    const sites = ['example.com', 'app.example.com'];
    expect(findMatchingSite('sub.app.example.com', sites)).toBe('app.example.com');
    expect(findMatchingSite('www.example.com', sites)).toBe('example.com');
    expect(findMatchingSite('other.com', sites)).toBeNull();
  });

  test('findMatchingSiteForCookie matches parent cookie to configured site', () => {
    expect(findMatchingSiteForCookie('.github.com', ['gist.github.com'])).toBe('gist.github.com');
    expect(findMatchingSiteForCookie('.other.com', ['github.com'])).toBeNull();
  });
});

describe('URL validation and match patterns', () => {
  test('isSyncableUrl accepts http/https and rejects internal browser URLs', () => {
    expect(isSyncableUrl('https://github.com/login')).toBe(true);
    expect(isSyncableUrl('http://localhost:3000/app')).toBe(true);
    expect(isSyncableUrl('chrome://extensions/')).toBe(false);
    expect(isSyncableUrl('edge://settings/')).toBe(false);
    expect(isSyncableUrl('about:blank')).toBe(false);
    expect(isSyncableUrl('file:///C:/index.html')).toBe(false);
    expect(isSyncableUrl('')).toBe(false);
  });

  test('buildMatchPatterns generates valid Chrome patterns for domains, IPs, and localhost', () => {
    expect(buildMatchPatterns(['example.com', 'localhost', '127.0.0.1'])).toEqual([
      '*://*.example.com/*',
      '*://localhost/*',
      '*://127.0.0.1/*'
    ]);
  });
});

describe('cookie details conversion', () => {
  test('buildCookieUrl uses http for non-secure cookies and https for secure/prefixed cookies', () => {
    expect(
      buildCookieUrl({ domain: 'localhost', path: '/', name: 'sid', secure: false })
    ).toBe('http://localhost/');
    expect(
      buildCookieUrl({ domain: '.example.com', path: '/app', name: 'sid', secure: true })
    ).toBe('https://example.com/app');
    expect(
      buildCookieUrl({ domain: 'example.com', path: '/', name: '__Host-token', secure: false })
    ).toBe('https://example.com/');
  });

  test('buildCookieSetDetails enforces __Host- rules and preserves partitionKey', () => {
    const details = buildCookieSetDetails(
      {
        name: '__Host-session',
        value: 'abc',
        domain: 'example.com',
        path: '/sub',
        secure: false,
        httpOnly: true,
        hostOnly: false,
        sameSite: 'lax',
        expirationDate: 1800000000,
        partitionKey: { topLevelSite: 'https://example.com' }
      },
      '1'
    );

    expect(details.domain).toBeUndefined();
    expect(details.path).toBe('/');
    expect(details.secure).toBe(true);
    expect(details.httpOnly).toBe(true);
    expect(details.sameSite).toBe('lax');
    expect(details.partitionKey).toEqual({ topLevelSite: 'https://example.com' });
    expect(details.storeId).toBe('1');
  });

  test('buildCookieSetDetails forces secure when sameSite is no_restriction', () => {
    const details = buildCookieSetDetails(
      {
        name: 'cross',
        value: '1',
        domain: '.example.com',
        path: '/',
        secure: false,
        httpOnly: false,
        hostOnly: false,
        sameSite: 'no_restriction'
      },
      '1'
    );
    expect(details.secure).toBe(true);
    expect(details.domain).toBe('.example.com');
  });

  test('buildCookieRemoveDetails keeps partitionKey', () => {
    const details = buildCookieRemoveDetails(
      {
        name: 'sid',
        domain: '.example.com',
        path: '/',
        secure: true,
        partitionKey: { topLevelSite: 'https://example.com' }
      },
      '1'
    );
    expect(details).toEqual({
      url: 'https://example.com/',
      name: 'sid',
      storeId: '1',
      partitionKey: { topLevelSite: 'https://example.com' }
    });
  });
});

describe('localStorage snapshot filtering', () => {
  test('filters out empty keys and oversized entries', () => {
    const huge = 'x'.repeat(MAX_LS_VALUE_BYTES);
    const result = filterLocalStorageItems([
      { key: '', value: 'ignored' },
      { key: 'token', value: 'jwt-123' },
      { key: 'blob', value: huge }
    ]);
    expect(result).toEqual([{ key: 'token', value: 'jwt-123' }]);
  });
});
