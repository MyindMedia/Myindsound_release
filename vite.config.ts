import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        login: resolve(__dirname, 'login.html'),
        dashboard: resolve(__dirname, 'dashboard.html'),
        physical: resolve(__dirname, 'physical.html'),
        stream: resolve(__dirname, 'stream.html'),
        success: resolve(__dirname, 'success.html'),
        cancel: resolve(__dirname, 'cancel.html'),
      },
    },
  },
});
