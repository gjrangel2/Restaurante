import http from 'node:http';
import cors from 'cors';
import express from 'express';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { errorHandler, notFoundHandler } from './http.js';
import { initRealtime } from './realtime/gateway.js';
import { api } from './routes.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // detrás de nginx
app.use(cors({ origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',') }));
app.use(express.json({ limit: '100kb' }));

app.use('/api', api);
app.use(notFoundHandler);
app.use(errorHandler);

const server = http.createServer(app);
const io = initRealtime(server);

if (config.runMigrations) {
  try {
    await migrate();
  } catch (err) {
    console.error(`[db] ${(err as Error).message}`);
    process.exit(1);
  }
}

server.listen(config.port, () => {
  console.log(`[api] FrictionlessOrder escuchando en http://localhost:${config.port}`);
});

// Apagado ordenado: deja de aceptar conexiones, cierra sockets y suelta el pool.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`[api] ${signal} recibido, cerrando…`);
    void io.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
