import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const execFileAsync = promisify(execFile);

export interface UploadResult {
  url: string;
  mimeType: string;
  size: number;
  filename: string;
}

/**
 * Stores user-uploaded media (agent recordings) and inbound media we
 * mirror locally (e.g., WhatsApp Cloud requires a Bearer token to
 * download — browsers can't load it directly, so we re-host it here).
 *
 * Files are written under `uploads/` and served publicly through
 * `/api/v1/uploads/*`. Swap with S3/R2 when we go multi-instance — the
 * public URL contract stays the same.
 */
@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);

  // 25MB matches OpenAI Whisper's upload cap, so audios we accept are also
  // transcribable without chunking.
  static readonly MAX_AUDIO_BYTES = 25 * 1024 * 1024;

  // 10MB cap for outbound images — generous for screenshots/photos but small
  // enough to keep the upload+send round-trip under a few seconds and to fit
  // comfortably under Zappfy/WhatsApp's 16MB media limit even after any
  // multipart overhead.
  static readonly MAX_IMAGE_BYTES = 10 * 1024 * 1024;

  // S18/W3-Z: caps por tipo de anexo genérico (drag-drop qualquer formato).
  // Documents: 50MB cobre PDFs grandes + planilhas Excel comuns sem inflar muito.
  // Video: 100MB alinha com WA Cloud Business limit (16MB Zappfy will reject —
  // a UI vai mostrar erro friendly antes do envio fallhar lá).
  // Audio (anexo, não voice note): 25MB, mesmo cap do /uploads/audio.
  static readonly MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
  static readonly MAX_VIDEO_BYTES = 100 * 1024 * 1024;
  static readonly MAX_FILE_BYTES = 100 * 1024 * 1024; // cap absoluto pro endpoint

  // 64MB upper bound for any inbound media we mirror. WhatsApp Cloud caps
  // documents at 100MB but most chat content is well under this — bigger
  // files we'd want to stream rather than buffer in memory anyway.
  static readonly MAX_INBOUND_BYTES = 64 * 1024 * 1024;

  private static readonly ALLOWED_AUDIO_MIME = new Set([
    'audio/mpeg',
    'audio/mp4',
    'audio/m4a',
    'audio/ogg',
    'audio/wav',
    'audio/webm',
    'audio/webm;codecs=opus',
  ]);

  private static readonly ALLOWED_IMAGE_MIME = new Set([
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/gif',
    'image/webp',
  ]);

  /**
   * S18/W3-Z: allow-list pro endpoint `/uploads/file` (drag-drop polimórfico).
   * Listas explícitas evitam confiar em parsing genérico. Imagens não vão aqui
   * (têm endpoint dedicado /uploads/image), mas se vier pelo file ainda assim,
   * são aceitas — saveFile detecta tipo e roteia internamente pro extFor.
   */
  private static readonly ALLOWED_DOCUMENT_MIME = new Set([
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/zip',
    'application/x-zip-compressed',
    'application/x-rar-compressed',
    'application/x-7z-compressed',
    'text/plain',
    'text/csv',
    'application/json',
  ]);

  private static readonly ALLOWED_VIDEO_MIME = new Set([
    'video/mp4',
    'video/quicktime',
    'video/webm',
    'video/3gpp',
    'video/x-matroska', // mkv (raro mas aparece)
  ]);

  /**
   * S18/W3-Z: magic bytes (header signature) check pra defesa em profundidade.
   * Atacante pode forjar Content-Type header (browser não valida payload), então
   * comparamos primeiros bytes contra assinaturas conhecidas pra cada MIME
   * sensível. Sem regex elaborado — só prefixos literais. Não cobre todos os
   * formatos (não vale a pena), mas pega os 80% comuns + casos de spoof óbvio.
   *
   * Fonte: https://en.wikipedia.org/wiki/List_of_file_signatures
   */
  private static readonly MAGIC_BYTES_BY_MIME: Record<string, Buffer[]> = {
    'application/pdf': [Buffer.from('25504446', 'hex')], // %PDF
    'application/zip': [Buffer.from('504b0304', 'hex'), Buffer.from('504b0506', 'hex')],
    'application/x-zip-compressed': [Buffer.from('504b0304', 'hex')],
    // DOCX/XLSX/PPTX são ZIPs internos — mesma magic
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': [Buffer.from('504b0304', 'hex')],
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': [Buffer.from('504b0304', 'hex')],
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': [Buffer.from('504b0304', 'hex')],
    // DOC/XLS/PPT legacy: D0CF11E0A1B11AE1 (OLE2)
    'application/msword': [Buffer.from('d0cf11e0a1b11ae1', 'hex')],
    'application/vnd.ms-excel': [Buffer.from('d0cf11e0a1b11ae1', 'hex')],
    'application/vnd.ms-powerpoint': [Buffer.from('d0cf11e0a1b11ae1', 'hex')],
    'video/mp4': [Buffer.from('66747970', 'hex')], // 'ftyp' (offset 4-8)
    'video/quicktime': [Buffer.from('66747970', 'hex')],
    'video/webm': [Buffer.from('1a45dfa3', 'hex')], // EBML
    // text/* skip — too varied, MIME header suficiente
  };

  private readonly rootDir: string;
  private readonly publicBaseUrl: string;

  constructor(private readonly config: ConfigService) {
    this.rootDir = path.resolve(
      this.config.get<string>('UPLOADS_DIR') ||
        path.join(process.cwd(), 'uploads'),
    );
    const appUrl = this.config.get<string>('APP_URL') || '';
    this.publicBaseUrl = `${appUrl.replace(/\/$/, '')}/api/v1/uploads`;
    if (!fs.existsSync(this.rootDir)) {
      fs.mkdirSync(this.rootDir, { recursive: true });
    }
  }

  /**
   * Persists an inbound media buffer (any type — image, video, audio,
   * document, sticker) under a per-channel/per-day folder and returns a
   * playable public URL. Used by adapters whose providers deliver media
   * gated behind auth (WhatsApp Cloud) or via short-lived signed URLs we
   * don't want to depend on.
   *
   * `originalFilename` is preserved when the provider gives one (typical
   * for documents) — useful for the UI to render a familiar filename and
   * for the browser's "Save As" dialog to default sensibly.
   */
  async saveInboundMedia(input: {
    buffer: Buffer;
    mimeType: string;
    channelId: string;
    originalFilename?: string | null;
  }): Promise<UploadResult> {
    if (!input?.buffer?.byteLength) {
      throw new BadRequestException('Empty inbound media');
    }
    if (input.buffer.byteLength > UploadsService.MAX_INBOUND_BYTES) {
      throw new BadRequestException(
        `Inbound media too large (max ${UploadsService.MAX_INBOUND_BYTES / 1024 / 1024}MB)`,
      );
    }

    const mime = (input.mimeType || 'application/octet-stream').split(';')[0].trim();
    const dateFolder = new Date().toISOString().slice(0, 10);
    const safeChannel = (input.channelId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
    const dir = path.join(this.rootDir, 'inbound', safeChannel, dateFolder);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const id = crypto.randomBytes(16).toString('hex');
    const ext = this.extFor(mime, input.originalFilename);
    const filename = `${id}${ext}`;
    const fullPath = path.join(dir, filename);
    await fs.promises.writeFile(fullPath, input.buffer);

    const url = `${this.publicBaseUrl}/inbound/${safeChannel}/${dateFolder}/${filename}`;
    this.logger.log(`Inbound media saved: ${fullPath} -> ${url}`);
    return {
      url,
      mimeType: mime,
      size: input.buffer.byteLength,
      filename: input.originalFilename || filename,
    };
  }

  async saveAudio(file: {
    buffer: Buffer;
    mimetype: string;
    originalname?: string;
  }): Promise<UploadResult> {
    if (!file?.buffer?.byteLength) {
      throw new BadRequestException('Empty upload');
    }
    if (file.buffer.byteLength > UploadsService.MAX_AUDIO_BYTES) {
      throw new BadRequestException(
        `Audio too large (max ${UploadsService.MAX_AUDIO_BYTES / 1024 / 1024}MB)`,
      );
    }
    // Normalise mimetype: browsers sometimes send `audio/webm;codecs=opus`.
    const mime = (file.mimetype || '').split(';')[0].trim() || 'audio/webm';
    if (!UploadsService.ALLOWED_AUDIO_MIME.has(file.mimetype) && !UploadsService.ALLOWED_AUDIO_MIME.has(mime)) {
      throw new BadRequestException(`Unsupported audio mime type: ${file.mimetype}`);
    }

    const dateFolder = new Date().toISOString().slice(0, 10);
    const dir = path.join(this.rootDir, 'audio', dateFolder);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const id = crypto.randomBytes(16).toString('hex');
    const srcExt = this.extFor(mime);
    const srcPath = path.join(dir, `${id}${srcExt}`);
    await fs.promises.writeFile(srcPath, file.buffer);

    // WhatsApp voice notes require OGG/Opus. Browsers (esp. Chrome/Firefox)
    // record in WebM/Opus via MediaRecorder — the codec is compatible but
    // the container is not, so Zappfy rejects the send (HTTP 500). We also
    // rely on the re-encode to write proper duration headers (MediaRecorder
    // streams webm without duration, so the <audio> element shows 0:00).
    let finalPath = srcPath;
    let finalMime = mime;
    if (mime !== 'audio/ogg') {
      const oggPath = path.join(dir, `${id}.ogg`);
      try {
        await execFileAsync(
          'ffmpeg',
          [
            '-hide_banner',
            '-loglevel', 'error',
            '-y',
            '-i', srcPath,
            '-vn',
            '-c:a', 'libopus',
            '-b:a', '32k',
            '-ac', '1',
            '-ar', '48000',
            '-application', 'voip',
            oggPath,
          ],
          { timeout: 30_000 },
        );
        await fs.promises.unlink(srcPath).catch(() => undefined);
        finalPath = oggPath;
        finalMime = 'audio/ogg';
      } catch (err: any) {
        this.logger.error(`ffmpeg transcode failed: ${err.message}`);
        throw new BadRequestException('Failed to process audio');
      }
    }

    const finalSize = (await fs.promises.stat(finalPath)).size;
    const finalName = path.basename(finalPath);
    const url = `${this.publicBaseUrl}/audio/${dateFolder}/${finalName}`;
    this.logger.log(`Audio saved: ${finalPath} -> ${url}`);
    return { url, mimeType: finalMime, size: finalSize, filename: finalName };
  }

  /**
   * Persists an agent-uploaded image (paste / drag-and-drop / file picker)
   * and returns a public URL ready to attach to an outbound IMAGE message.
   *
   * Validates MIME against an allow-list (jpeg/png/gif/webp) — we reject
   * anything else to avoid the provider 500-ing on exotic formats, and to
   * keep the surface area predictable for the contact preview thumbnail.
   *
   * We DO NOT re-encode the image (unlike audio): provider compatibility
   * for these formats is good enough across Zappfy/WhatsApp Cloud/IG, and
   * re-encoding would either degrade quality or balloon CPU/memory.
   */
  async saveImage(file: {
    buffer: Buffer;
    mimetype: string;
    originalname?: string;
  }): Promise<UploadResult> {
    if (!file?.buffer?.byteLength) {
      throw new BadRequestException('Empty upload');
    }
    if (file.buffer.byteLength > UploadsService.MAX_IMAGE_BYTES) {
      throw new BadRequestException(
        `Image too large (max ${UploadsService.MAX_IMAGE_BYTES / 1024 / 1024}MB)`,
      );
    }
    const mime = (file.mimetype || '').split(';')[0].trim().toLowerCase();
    if (!UploadsService.ALLOWED_IMAGE_MIME.has(mime)) {
      throw new BadRequestException(`Unsupported image mime type: ${file.mimetype}`);
    }

    const dateFolder = new Date().toISOString().slice(0, 10);
    const dir = path.join(this.rootDir, 'images', dateFolder);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const id = crypto.randomBytes(16).toString('hex');
    const ext = this.extFor(mime, file.originalname);
    const filename = `${id}${ext}`;
    const fullPath = path.join(dir, filename);
    await fs.promises.writeFile(fullPath, file.buffer);

    const url = `${this.publicBaseUrl}/images/${dateFolder}/${filename}`;
    this.logger.log(`Image saved: ${fullPath} -> ${url}`);
    return {
      url,
      mimeType: mime,
      size: file.buffer.byteLength,
      filename: file.originalname || filename,
    };
  }

  /**
   * S18/W3-Z: aceita anexo de QUALQUER tipo (document/video/audio/image)
   * vindo do composer (drag-drop, paste, file picker). Roteia internamente
   * pro endpoint certo via MIME header e valida magic bytes pra prevenir
   * spoof (browser não verifica payload contra Content-Type).
   *
   * Retorna URL pública + contentTypeBucket pra frontend mapear pro
   * Message.contentType (IMAGE/AUDIO/VIDEO/DOCUMENT) sem precisar parsear
   * MIME de novo.
   */
  async saveFile(file: {
    buffer: Buffer;
    mimetype: string;
    originalname?: string;
  }): Promise<UploadResult & { contentTypeBucket: 'IMAGE' | 'AUDIO' | 'VIDEO' | 'DOCUMENT' }> {
    if (!file?.buffer?.byteLength) {
      throw new BadRequestException('Empty upload');
    }
    if (file.buffer.byteLength > UploadsService.MAX_FILE_BYTES) {
      throw new BadRequestException(
        `File too large (max ${UploadsService.MAX_FILE_BYTES / 1024 / 1024}MB)`,
      );
    }

    const mimeRaw = (file.mimetype || '').toLowerCase();
    const mime = mimeRaw.split(';')[0].trim();

    // Routing por bucket — cada bucket tem cap próprio.
    let bucket: 'IMAGE' | 'AUDIO' | 'VIDEO' | 'DOCUMENT';
    let subdir: string;
    let bucketCap: number;

    if (UploadsService.ALLOWED_IMAGE_MIME.has(mime)) {
      bucket = 'IMAGE';
      subdir = 'images';
      bucketCap = UploadsService.MAX_IMAGE_BYTES;
    } else if (UploadsService.ALLOWED_AUDIO_MIME.has(mime) || UploadsService.ALLOWED_AUDIO_MIME.has(mimeRaw)) {
      bucket = 'AUDIO';
      subdir = 'audio';
      bucketCap = UploadsService.MAX_AUDIO_BYTES;
    } else if (UploadsService.ALLOWED_VIDEO_MIME.has(mime)) {
      bucket = 'VIDEO';
      subdir = 'videos';
      bucketCap = UploadsService.MAX_VIDEO_BYTES;
    } else if (UploadsService.ALLOWED_DOCUMENT_MIME.has(mime) || mime.startsWith('text/')) {
      bucket = 'DOCUMENT';
      subdir = 'documents';
      bucketCap = UploadsService.MAX_DOCUMENT_BYTES;
    } else {
      throw new BadRequestException(`Unsupported file mime type: ${file.mimetype}`);
    }

    if (file.buffer.byteLength > bucketCap) {
      throw new BadRequestException(
        `${bucket} too large (max ${bucketCap / 1024 / 1024}MB for this type)`,
      );
    }

    // Magic bytes check — só pra MIMEs com signature conhecida.
    const signatures = UploadsService.MAGIC_BYTES_BY_MIME[mime];
    if (signatures && signatures.length > 0) {
      const header = file.buffer.subarray(0, 16);
      // MP4/MOV: signature 'ftyp' aparece em offset 4-8, não 0
      const matched = signatures.some((sig) => {
        if (mime === 'video/mp4' || mime === 'video/quicktime') {
          return file.buffer.length >= 12 && file.buffer.subarray(4, 8).equals(sig);
        }
        return header.subarray(0, sig.length).equals(sig);
      });
      if (!matched) {
        throw new BadRequestException(
          `File content does not match declared MIME type (${mime}). Possible spoofed extension.`,
        );
      }
    }

    const dateFolder = new Date().toISOString().slice(0, 10);
    const dir = path.join(this.rootDir, subdir, dateFolder);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const id = crypto.randomBytes(16).toString('hex');
    const ext = this.extFor(mime, file.originalname);
    const filename = `${id}${ext}`;
    const fullPath = path.join(dir, filename);
    await fs.promises.writeFile(fullPath, file.buffer);

    const url = `${this.publicBaseUrl}/${subdir}/${dateFolder}/${filename}`;
    this.logger.log(`File saved (${bucket}): ${fullPath} -> ${url}`);
    return {
      url,
      mimeType: mime,
      size: file.buffer.byteLength,
      filename: file.originalname || filename,
      contentTypeBucket: bucket,
    };
  }

  private extFor(mime: string, originalFilename?: string | null): string {
    // Prefer the extension from the provider-given filename when present —
    // it survives mime-sniffing oddities (e.g., Meta sometimes returns
    // application/octet-stream for known doc types).
    if (originalFilename) {
      const ext = path.extname(originalFilename).toLowerCase();
      if (ext && /^\.[a-z0-9]{1,8}$/i.test(ext)) return ext;
    }
    const m = (mime || '').toLowerCase();
    // audio
    if (m.includes('ogg')) return '.ogg';
    if (m.includes('mpeg') && m.startsWith('audio/')) return '.mp3';
    if (m.includes('m4a') || (m.includes('mp4') && m.startsWith('audio/'))) return '.m4a';
    if (m.includes('wav')) return '.wav';
    if (m.includes('webm') && m.startsWith('audio/')) return '.webm';
    // image
    if (m === 'image/jpeg' || m === 'image/jpg') return '.jpg';
    if (m === 'image/png') return '.png';
    if (m === 'image/gif') return '.gif';
    if (m === 'image/webp') return '.webp';
    if (m === 'image/heic') return '.heic';
    // video
    if (m === 'video/mp4') return '.mp4';
    if (m === 'video/quicktime') return '.mov';
    if (m === 'video/3gpp') return '.3gp';
    if (m === 'video/webm') return '.webm';
    // document
    if (m === 'application/pdf') return '.pdf';
    if (m === 'application/zip') return '.zip';
    if (m === 'application/msword') return '.doc';
    if (m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return '.docx';
    if (m === 'application/vnd.ms-excel') return '.xls';
    if (m === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return '.xlsx';
    if (m === 'application/vnd.ms-powerpoint') return '.ppt';
    if (m === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return '.pptx';
    if (m === 'text/plain') return '.txt';
    if (m === 'text/csv') return '.csv';
    return '.bin';
  }
}
