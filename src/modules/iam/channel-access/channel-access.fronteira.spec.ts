import { NotFoundException } from '@nestjs/common';
import { ChannelAccessService } from './channel-access.service';

describe('fronteira da conversa', () => {
  it('nega conversa de outra organização mesmo com ALL', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const svc = new ChannelAccessService({ conversation: { findFirst } } as any);
    await expect((svc as any).assertConversationAccess('ALL', 'conv-b', 'org-a')).rejects.toBeInstanceOf(NotFoundException);
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'conv-b', organizationId: 'org-a' } }));
  });
  it('permite conversa da organização ativa com ALL', async () => {
    const findFirst = jest.fn().mockResolvedValue({ channelId: 'canal-a' });
    const svc = new ChannelAccessService({ conversation: { findFirst } } as any);
    await expect((svc as any).assertConversationAccess('ALL', 'conv-a', 'org-a')).resolves.toBeUndefined();
  });
});
