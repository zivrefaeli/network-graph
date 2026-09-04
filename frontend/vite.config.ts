import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// The @/ alias has to be declared here as well as in tsconfig.json: TypeScript
// resolves types and Vite resolves the bundle, and neither reads the other's
// config. If an import works in the editor but not at build time, these two
// have drifted apart.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
})
