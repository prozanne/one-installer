import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const alias = {
  '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
  '@main': fileURLToPath(new URL('./src/main', import.meta.url)),
  '@renderer': fileURLToPath(new URL('./src/renderer', import.meta.url)),
};

export default defineConfig(({ mode }) => {
  const prod = mode === 'production';
  // Strip sourcemaps + non-essential metadata in production. Keeps the
  // shipped installer lean — every megabyte the user downloads on first
  // install delays their "is it working yet?" gut feel. In dev we keep
  // sourcemaps on so stack traces remain readable.
  const minify = prod ? 'esbuild' : false;
  const sourcemap = !prod;

  return {
    main: {
      resolve: { alias },
      plugins: [externalizeDepsPlugin()],
      build: {
        outDir: 'out/main',
        sourcemap,
        minify,
        rollupOptions: {
          input: 'src/main/electron-main.ts',
        },
      },
    } as never,
    preload: {
      resolve: { alias },
      plugins: [externalizeDepsPlugin()],
      build: {
        outDir: 'out/preload',
        sourcemap,
        minify,
        rollupOptions: {
          input: 'src/preload/index.ts',
        },
      },
    } as never,
    renderer: {
      resolve: { alias },
      root: fileURLToPath(new URL('./src/renderer', import.meta.url)),
      plugins: [react()],
      build: {
        outDir: fileURLToPath(new URL('./out/renderer', import.meta.url)),
        emptyOutDir: true,
        sourcemap,
        minify,
        // Drop console.* and debugger statements at minify time so dev-only
        // logging doesn't bloat the renderer bundle in production.
        ...(prod
          ? {
              esbuild: {
                drop: ['console', 'debugger'],
              },
            }
          : {}),
        rollupOptions: {
          input: fileURLToPath(new URL('./src/renderer/index.html', import.meta.url)),
        },
      },
    } as never,
  };
});
