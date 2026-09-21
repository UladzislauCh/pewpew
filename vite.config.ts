import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { evalCacheServer } from './scripts/evalCacheServer'
import { fixtureServer } from './scripts/fixtureServer'
import { labelerServer } from './scripts/labelerServer'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), labelerServer(), evalCacheServer(), fixtureServer()],
  build: {
    // Chunk names are hash-only, no module name: don't reveal the bundle's structure
    // in devtools/network. Loading logic doesn't depend on filenames (Vite rewrites
    // imports and worker/wasm URLs to the final paths itself).
    rollupOptions: {
      output: {
        chunkFileNames: 'assets/[hash].js',
        entryFileNames: 'assets/[hash].js',
        assetFileNames: 'assets/[hash][extname]',
      },
    },
    minify: 'terser',
    terserOptions: {
      // Do NOT enable mangle.properties — it renames object properties (including ones
      // visible outside a module or used as string keys) and breaks the runtime.
      mangle: {
        toplevel: true,
      },
      compress: {
        toplevel: true,
        passes: 2,
      },
      format: {
        comments: false,
      },
    },
  },
  optimizeDeps: {
    // mediabunny and onnxruntime-web/webgpu only enter the graph through dynamic
    // import() from WizardApp (media analysis, flash detection), with no static path
    // from the entry point. Without an explicit include, Vite only discovers them the
    // first time the user adds a video, rebuilds the deps cache and reloads the page —
    // the wizard form resets and the file is lost. include forces them to be
    // pre-bundled when the dev server starts.
    include: ['mediabunny', 'onnxruntime-web/webgpu'],
  },
  worker: {
    // flashWorker.ts is built by a separate Rollup sub-bundler (new Worker(new
    // URL(...))) — build.rollupOptions.output doesn't apply to it. Without this
    // override, onnxruntime's wasm inside the worker gets the old-style name
    // (assets/ort-wasm-simd-threaded.asyncify-<hash>.wasm), while outside the worker
    // it gets the new hashed name: the same 25 MB wasm file ends up duplicated in
    // dist. The same naming pattern collapses them back into one physical file
    // (the content hash matches).
    rollupOptions: {
      output: {
        chunkFileNames: 'assets/[hash].js',
        entryFileNames: 'assets/[hash].js',
        assetFileNames: 'assets/[hash][extname]',
      },
    },
  },
})
