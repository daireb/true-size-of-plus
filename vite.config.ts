import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // GitHub Pages serves project sites under /<repo>/. Only the deploy script
  // sets GHPAGES, so local dev and the smoke tests stay at plain /.
  base: process.env.GHPAGES ? '/worldscale/' : '/',
})
