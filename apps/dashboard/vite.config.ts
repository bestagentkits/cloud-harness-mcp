import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The production bundle is served same-origin by the Express API under `/dashboard/`
 * (see `apps/api/src/dashboard-react-assets.ts`) behind a CSP without `unsafe-inline`.
 * Every option below keeps the emitted HTML free of inline script and style:
 *
 * - `modulePreload.polyfill: false` drops Vite's injected preload polyfill; every
 *   browser the Dashboard supports implements `<link rel="modulepreload">`.
 * - `assetsInlineLimit: 0` keeps fonts and images as hashed files instead of `data:`
 *   URIs, so the CSP needs only `font-src 'self'`.
 * - `cssCodeSplit: false` emits one stylesheet linked from `index.html`.
 * - `html.cspNonce` stamps a per-response placeholder that the API replaces with a
 *   fresh nonce; runtime-injected `<style>` tags (Radix scroll lock) read it.
 *
 * `scripts/verify-build-output.mjs` fails the build if any of this regresses.
 */
export const CSP_NONCE_PLACEHOLDER = '__CH_CSP_NONCE__';

export default defineConfig({
  base: '/dashboard/',
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true, routesDirectory: './src/routes', generatedRouteTree: './src/routeTree.gen.ts' }),
    react(),
    tailwindcss()
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) }
  },
  html: { cspNonce: CSP_NONCE_PLACEHOLDER },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    manifest: true,
    sourcemap: false,
    target: 'es2023',
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    }
  },
  // `npm run dev` serves the app with hot reload and forwards the BFF to a running API
  // (`npm run dev:api`); override the target with DASHBOARD_DEV_API_ORIGIN.
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/dashboard/api': { target: process.env.DASHBOARD_DEV_API_ORIGIN ?? 'http://127.0.0.1:3000', changeOrigin: false }
    }
  }
});
