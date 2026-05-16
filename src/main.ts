import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppService } from './app.service';
import * as http from 'http';

async function bootstrap() {
  // 1. Initialize NestJS without the logger
  const app = await NestFactory.create(AppModule, { logger: false });
  const appService = app.get(AppService);
  
  // 2. Get the underlying HTTP server and Express instance
  const server = app.getHttpServer();
  const nextHandler = server.listeners('request')[0];

  // 3. Replace the request listener with a high-performance bypass
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    // HIGH-SPEED PATH: /fraud-score
    if (req.method === 'POST' && req.url === '/fraud-score') {
      let bodyStr = '';
      req.on('data', (chunk) => { bodyStr += chunk; });
      req.on('end', () => {
        try {
          const body = JSON.parse(bodyStr);
          const result = appService.execute(body);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(400);
          res.end();
        }
      });
      return;
    }

    // NORMAL PATH: Everything else (NestJS)
    if (nextHandler) {
      nextHandler(req, res);
    }
  });

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
