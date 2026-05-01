import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const alias = {
  '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
  '@main': fileURLToPath(new URL('./src/main', import.meta.url)),
  '@renderer': fileURLToPath(new URL('./src/renderer', import.meta.url)),
};

export default defineConfig(() => ({
  main: {
    resolve: { alias },
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
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
      rollupOptions: {
        input: fileURLToPath(new URL('./src/renderer/index.html', import.meta.url)),
      },
    },
  } as never,
}));
