import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// The @/ alias has to be declared here as well as in tsconfig.json: TypeScript
// resolves types and Vite resolves the bundle, and neither reads the other's
// config. If an import works in the editor but not at build time, these two
// have drifted apart.
export default defineConfig(({ command }) => ({
  // Relative asset URLs for the build, so the output can be served from a
  // subpath -- which is what GitHub Pages does with frontend/mock/. The dev
  // server keeps an absolute base, where a relative one has no meaning.
  base: command === 'build' ? './' : '/',
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    host: true,
    // Everything under /api is forwarded to the backend, so development makes
    // no cross-origin request at all and needs no CORS. The rewrite strips the
    // prefix because the backend serves /health and /captures at its root.
    proxy: {
      '/api': {
        target: process.env['VITE_PROXY_TARGET'] ?? 'http://localhost:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
}))
