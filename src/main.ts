import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import * as express from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { AppModule } from './app.module';
import { StorageService } from './modules/storage/storage.service';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { RedisIoAdapter } from './modules/realtime/redis-io.adapter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const config = app.get(ConfigService);
  const storage = app.get(StorageService);
  const logger = new Logger('Bootstrap');

  if (RedisIoAdapter.isEnabled(config)) {
    const redisIoAdapter = new RedisIoAdapter(app, config);
    await redisIoAdapter.connectToRedis();
    app.useWebSocketAdapter(redisIoAdapter);
  } else {
    logger.log('Socket.IO Redis adapter disabled; running in single-instance mode');
  }

  // helmet blocks cross-origin media by default; relax that for <audio>/<img>
  // tags served by this API (same origin, but browsers enforce CORP).
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.setGlobalPrefix('api/v1');

  // Serve locally-stored user uploads (audio, etc.) before the global prefix
  // kicks in. This is set up pre-prefix so the path matches both in dev and
  // behind the reverse-proxy.
  const uploadsDir = path.resolve(
    config.get<string>('UPLOADS_DIR') || path.join(process.cwd(), 'uploads'),
  );
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
  app.use(
    '/api/v1/uploads',
    express.static(uploadsDir, {
      maxAge: '30d',
      // fallthrough:true (default) deixa o NestJS gerar 404 limpo pra arquivo
      // ausente. Com false, o static chama next(err) com um erro genérico ENOENT
      // que o GlobalExceptionFilter (@Catch() = pega tudo) convertia em 500
      // opaco. Isso fazia o frontend cair no estado fallback ("Imagem" sem
      // thumbnail) sempre que o blob fosse perdido — comum em prod até a
      // configuração do volume persistente (uploads era efêmero). Bug
      // descoberto 2026-05-16 quando Doc enviou screenshot via paste em prod.
      fallthrough: true,
      index: false,
    }),
  );

  // Endpoint amigável para providers (Zappfy/Uazapi) baixarem mídia com o nome
  // original do arquivo no path. O provider extrai o filename do path da URL,
  // então servimos uma URL como /uploads/media/nome-original.zip?key=...hash...
  app.getHttpAdapter().get('/api/v1/uploads/media/:filename', async (req: any, res: any) => {
    const filename = req.params.filename;
    const key = String(req.query.key || '');
    if (!key || !/^(documents|images|videos|audio)\/[\w\-/.]+$/.test(key)) {
      return res.status(400).json({ message: 'Invalid media key' });
    }
    if (key.includes('..')) {
      return res.status(400).json({ message: 'Invalid media key' });
    }
    const filePath = path.join(uploadsDir, key);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return sendStoredUpload(storage, key, res, filename);
    }
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Cache-Control', 'public, max-age=2592000');
    return res.sendFile(filePath);
  });

  app.getHttpAdapter().get('/api/v1/uploads/:bucket/:date/:filename', async (req: any, res: any) => {
    const { bucket, date, filename } = req.params;
    const key = `${bucket}/${date}/${filename}`;
    if (!/^(documents|images|videos|audio)\/\d{4}-\d{2}-\d{2}\/[\w.-]+$/.test(key)) {
      return res.status(400).json({ message: 'Invalid upload key' });
    }
    return sendStoredUpload(storage, key, res, filename);
  });

  app.getHttpAdapter().get('/api/v1/uploads/inbound/:channel/:date/:filename', async (req: any, res: any) => {
    const { channel, date, filename } = req.params;
    const key = `inbound/${channel}/${date}/${filename}`;
    if (!/^inbound\/[\w-]+\/\d{4}-\d{2}-\d{2}\/[\w.-]+$/.test(key)) {
      return res.status(400).json({ message: 'Invalid upload key' });
    }
    return sendStoredUpload(storage, key, res, filename);
  });
  // CORS_ORIGIN aceita lista separada por virgula (ex: "https://web.com,http://localhost:3000").
  // Sem o split, NestJS envia a string toda como Access-Control-Allow-Origin, e o browser
  // rejeita ("multiple values, but only one is allowed"). Array faz o NestJS escolher
  // dinamicamente o origin que bate com o request.
  const corsOrigins = config
    .get<string>('CORS_ORIGIN', 'http://localhost:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: corsOrigins.length === 1 ? corsOrigins[0] : corsOrigins,
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalInterceptors(new LoggingInterceptor(), new ResponseInterceptor());

  const swagger = new DocumentBuilder()
    .setTitle('Chat BullQ API')
    .setDescription('Omnichannel customer service API')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swagger));

  const port = config.get<number>('PORT', 3001);
  await app.listen(port);
  logger.log(`API running on http://localhost:${port}`);
  logger.log(`Swagger docs at http://localhost:${port}/docs`);
}

bootstrap();

async function sendStoredUpload(
  storage: StorageService,
  key: string,
  res: any,
  filename?: string,
) {
  if (key.includes('..') || !storage.isReady()) {
    return res.status(404).json({ message: 'File not found' });
  }

  try {
    const client = storage.getClient();
    const stat = await client.statObject(storage.getBucket(), key);
    const contentType =
      stat.metaData?.['content-type'] ||
      stat.metaData?.['Content-Type'] ||
      'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=2592000');
    if (filename) {
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    }
    const objectStream = await client.getObject(storage.getBucket(), key);
    return objectStream.pipe(res);
  } catch {
    return res.status(404).json({ message: 'File not found' });
  }
}
