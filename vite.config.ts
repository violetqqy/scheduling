import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  base: './',
  server: { port: 5178, strictPort: true },
  preview: { port: 4178, strictPort: true },
  build: { rollupOptions: { output: { manualChunks: { excel: ['exceljs'] } } } },
})
