/**
 * Service worker registration.
 *
 * Only registered in a production build: in development the SW would fight Vite's module graph
 * and serve stale files. Registration failures are non-fatal — the app works online without it.
 */
export function registerServiceWorker(options: { onUpdateReady?: () => void } = {}): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  if (!import.meta.env.PROD) return
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(new URL('sw.js', document.baseURI).toString(), { scope: './' })
      .then((registration) => {
        registration.addEventListener('updatefound', () => {
          const installing = registration.installing
          if (!installing) return
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              options.onUpdateReady?.()
            }
          })
        })
      })
      .catch((error) => {
        console.warn('[pulsegrid] service worker registration failed:', error)
      })
  })
}
