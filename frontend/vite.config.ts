import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// En desarrollo (npm run dev) Vite reenvía la API y los WebSockets al backend
// local, igual que hace nginx dentro de Docker. Así el frontend siempre habla
// con su mismo origen y no hay CORS que configurar.
const backend = process.env.VITE_BACKEND_URL ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // accesible desde el móvil en la misma red
    port: 5173,
    proxy: {
      '/api': { target: backend, changeOrigin: true },
      '/socket.io': { target: backend, changeOrigin: true, ws: true },
    },
  },
});
