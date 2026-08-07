import { createRoot } from 'react-dom/client'
import App from './App.tsx'

// StrictMode is deliberately off. Its dev-only mount/unmount/remount tears down
// and rebuilds MapLibre's WebGL context and worker pool on every mount, which is
// both wasteful and a common source of flakiness in map apps. Nothing here
// depends on it; re-enable if you want the extra dev checks and the map behaves.
createRoot(document.getElementById('root')!).render(<App />)
