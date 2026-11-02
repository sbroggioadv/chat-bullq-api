import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UploadsService } from './uploads.service';
import { StorageService } from '../../storage/storage.service';

// SPEC-017 rodada 3 (B) — apagar a mídia espelhada que ficou sem referência.

const APP_URL = 'https://api.bullq.test';

function uploadsIn(dir: string, remote?: { removeObject: jest.Mock }) {
  const config = { get: (k: string) => ({ UPLOADS_DIR: dir, APP_URL })[k] } as unknown as ConfigService;
  const storage = {
    isReady: () => !!remote,
    getClient: () => remote,
    getBucket: () => 'bucket-test',
  } as unknown as StorageService;
  return new UploadsService(config, storage);
}

describe('UploadsService.deleteInboundMedia', () => {
  let dir: string;
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec017-uploads-'));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('apaga do disco o arquivo que saveInboundMedia acabou de gravar', async () => {
    const uploads = uploadsIn(dir);
    const saved = await uploads.saveInboundMedia({ buffer: Buffer.from([1, 2, 3]), mimeType: 'image/jpeg', channelId: 'ch1' });
    const file = path.join(dir, saved.url.slice(`${APP_URL}/api/v1/uploads/`.length));
    const existedBefore = fs.existsSync(file);

    const deleted = await uploads.deleteInboundMedia(saved.url);

    expect(existedBefore).toBe(true);
    expect(deleted).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('com storage S3 pronta, remove o objeto pela chave', async () => {
    const remote = { removeObject: jest.fn(async () => undefined), putObject: jest.fn(async () => undefined) } as any;
    const uploads = uploadsIn(dir, remote);
    const saved = await uploads.saveInboundMedia({ buffer: Buffer.from([1]), mimeType: 'video/mp4', channelId: 'ch1' });

    await uploads.deleteInboundMedia(saved.url);

    expect(remote.removeObject).toHaveBeenCalledWith('bucket-test', saved.url.slice(`${APP_URL}/api/v1/uploads/`.length));
  });

  it.each([
    ['URL de outro host', 'https://evil.example.com/api/v1/uploads/inbound/ch1/2026-11-02/' + 'a'.repeat(32) + '.jpg'],
    ['pasta que não é inbound', `${APP_URL}/api/v1/uploads/audio/2026-11-02/${'a'.repeat(32)}.ogg`],
    ['tentativa de subir pasta', `${APP_URL}/api/v1/uploads/inbound/../../etc/passwd`],
    ['nome fora do formato', `${APP_URL}/api/v1/uploads/inbound/ch1/2026-11-02/qualquer.jpg`],
  ])('recusa %s sem tocar a storage', async (_label, url) => {
    const remote = { removeObject: jest.fn(), putObject: jest.fn() } as any;
    const uploads = uploadsIn(dir, remote);

    const deleted = await uploads.deleteInboundMedia(url);

    expect(deleted).toBe(false);
    expect(remote.removeObject).not.toHaveBeenCalled();
  });
});
