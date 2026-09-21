// Builds the extension into extension/dist, ready for chrome://extensions
// "Load unpacked". public/ (manifest, icons, the two page scripts) is copied
// as it is; the popup and the background worker are bundled.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome111',
    modulePreload: false,
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'popup.html'),
        background: resolve(__dirname, 'src/background.js'),
      },
      output: {
        entryFileNames: (c) => (c.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
})
