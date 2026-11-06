/**
 * Beatbreak entry point.
 *
 * StrictMode is deliberately not used: the gameplay and import effects own real resources
 * (AudioContext sources, workers, rAF loops) and React's double-invocation of effects in
 * development would abort the first import and start a second audio graph. The lifecycle is
 * handled explicitly in each screen's cleanup instead.
 */
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { registerServiceWorker } from './pwa/register'
import { settingsStore } from './store/settings'
import '@fontsource/bungee/latin-400.css'
import '@fontsource/barlow/latin-500.css'
import '@fontsource/barlow/latin-600.css'
import '@fontsource/barlow/latin-700.css'
import './styles/app.css'
import './styles/theme-disco.css'
import './styles/theme-mono.css'
import { UPDATE_READY_EVENT } from './pwa/register'

const container = document.getElementById('root')
if (!container) throw new Error('#root is missing from index.html')

// Apply the stored theme before the first paint so switching themes never flashes the other skin.
document.documentElement.dataset.theme = settingsStore.get().theme

// The playfield canvas only gets these faces once they are loaded, so ask for them up front.
void document.fonts?.load('30px Bungee')
void document.fonts?.load('600 15px Barlow')

createRoot(container).render(<App />)

registerServiceWorker({
  onUpdateReady: () => {
    // A new build took over; the app tells the player once they are out of a run.
    window.dispatchEvent(new Event(UPDATE_READY_EVENT))
  },
})
