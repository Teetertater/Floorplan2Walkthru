import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';

export default defineConfig({
  assetsInclude: ['**/*.hdr'],
  server: {
    port: 5173,
  },
  plugins: [
    {
      name: 'screenshot-api',
      configureServer(server) {
        server.middlewares.use('/api/screenshot', (req, res) => {
          if (req.method === 'POST') {
            let body = '';
            req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
            req.on('end', () => {
              try {
                const { image, name } = JSON.parse(body);
                const base64 = image.replace(/^data:image\/png;base64,/, '');
                const dir = path.resolve(__dirname, 'screenshots');
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                const filename = name ? `birdseye_${name}.png` : 'birdseye.png';
                fs.writeFileSync(path.join(dir, filename), Buffer.from(base64, 'base64'));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
              } catch (e) {
                res.writeHead(500);
                res.end(JSON.stringify({ error: String(e) }));
              }
            });
          } else {
            res.writeHead(405);
            res.end('POST only');
          }
        });
      },
    },
  ],
});
