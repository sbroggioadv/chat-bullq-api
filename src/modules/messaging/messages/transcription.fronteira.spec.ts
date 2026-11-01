import { NotFoundException } from '@nestjs/common';
import { TranscriptionService } from './transcription.service';

describe('fronteira da transcrição', () => {
  it('oculta áudio de outra organização e conserva transcrição autorizada', async () => {
    const result = { text: 'teste', provider: 'openai-whisper', transcribedAt: '2026-01-01' };
    const message = { conversation: { organizationId: 'A', channelId: 'channel-A' }, type: 'AUDIO', metadata: { transcription: result } };
    const prisma = { message: { findUnique: jest.fn(async () => message) } };
    const service = new TranscriptionService(prisma as any, {} as any, {} as any, {} as any, {} as any);
    await expect(service.transcribe('message-A', 'B')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.transcribe('message-A', 'A')).resolves.toEqual(result);
  });
});
