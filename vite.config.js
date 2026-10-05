import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/* Which build is actually live.
 *
 * Written into the HTML as a meta tag, so it can be read with one request
 * against the deployed site rather than guessed at from minified class names.
 * Worth the ten lines: an evening was spent wondering why changes had not
 * appeared, and the answer was that the deployed build predated them, which
 * this makes a two-second question.
 *
 * Vercel sets VERCEL_GIT_COMMIT_SHA during a build. Locally there is a git
 * checkout to ask. Neither is fatal if missing.
 */
function buildStamp() {
  const sha =
    process.env.VERCEL_GIT_COMMIT_SHA ??
    (() => {
      try { return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() }
      catch { return null }
    })()
  return `${sha ? sha.slice(0, 7) : 'unknown'} ${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}`
}

function stampPlugin() {
  const stamp = buildStamp()
  return {
    name: 'thruscan-build-stamp',
    transformIndexHtml(html) {
      return html.replace('</head>', `  <meta name="thruscan-build" content="${stamp}">\n  </head>`)
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), stampPlugin()],
})
