// Arcwise server: Express serves /api and hands every other request to Next.js.
import express from 'express';
import path from 'node:path';
import next from 'next';
import { authRouter } from './auth';
import { apiRouter } from './routes';

try { process.loadEnvFile('.env'); } catch { /* .env is optional */ }

const dev = process.env.NODE_ENV !== 'production';
const port = Number(process.env.PORT ?? 3000);

const app = next({ dev, dir: process.cwd() });
const handle = app.getRequestHandler();

await app.prepare();
const server = express();
server.disable('x-powered-by');
server.set('trust proxy', 1);
server.use((_req, res, nextFn) => {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  nextFn();
});
// The homepage is the authored Sylva world carrying Arcwise content, served as-is.
server.get('/', (_req, res) => { res.sendFile(path.resolve('public/landing-pages/arcwise-home.html')); });
server.use('/auth', authRouter());
server.use('/api', apiRouter());
server.use((req, res) => handle(req, res));

server.listen(port, () => {
  console.log(`Arcwise ready on http://localhost:${port} (${dev ? 'development' : 'production'})`);
});
