/**
 * PWA retirement helpers.
 *
 * The owner does not use the installable/offline PWA.  `/mobile` redirects to
 * `/console`.  This module (1) exposes a tiny inline script that unregisters
 * leftover service workers and drops Cache Storage, and (2) keeps the same
 * cleanup testable without a browser.
 */

export type ServiceWorkerLikeRegistration = {
  unregister: () => Promise<boolean>;
};

export async function clearStalePwaState(input: {
  getRegistrations?: () => Promise<ServiceWorkerLikeRegistration[]>;
  cacheKeys?: () => Promise<string[]>;
  deleteCache?: (key: string) => Promise<boolean>;
}): Promise<{ unregistered: number; cachesCleared: number }> {
  let unregistered = 0;
  let cachesCleared = 0;

  if (input.getRegistrations) {
    const registrations = await input.getRegistrations();
    for (const registration of registrations) {
      if (await registration.unregister()) unregistered += 1;
    }
  }

  if (input.cacheKeys && input.deleteCache) {
    const keys = await input.cacheKeys();
    for (const key of keys) {
      if (await input.deleteCache(key)) cachesCleared += 1;
    }
  }

  return { unregistered, cachesCleared };
}

/** Runs before paint on every page so a leftover controlling worker cannot keep serving stale HTML. */
export const pwaUnregisterScript =
  '(function(){try{if(!("serviceWorker"in navigator))return;navigator.serviceWorker.getRegistrations().then(function(rs){rs.forEach(function(r){r.unregister();});});if(window.caches){caches.keys().then(function(keys){keys.forEach(function(k){caches.delete(k);});});}}catch(e){}})();';
