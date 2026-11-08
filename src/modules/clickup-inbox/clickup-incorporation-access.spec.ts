import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ClickUpInboxWorkbenchController } from './clickup-inbox-workbench.controller';
import { ClickUpInboxGroupController } from './clickup-inbox-group.controller';
import { ChannelAccessService } from '../iam/channel-access/channel-access.service';

describe.each([ClickUpInboxWorkbenchController, ClickUpInboxGroupController])('F9 autorização %p', Controller => {
  it('recusa canal/org alheia antes de incorporar, e passa o contrato válido', async () => {
    const service: any = { incorporateWorkbench: jest.fn().mockResolvedValue({ ok: true }), incorporateGroup: jest.fn().mockResolvedValue({ ok: true }) };
    const prisma: any = { conversation: { findFirst: jest.fn(async ({ where }: any) => where.organizationId === 'org' ? { channelId: 'channel' } : null) } };
    const controller: any = new (Controller as any)(service, new ChannelAccessService(prisma));
    const body = { kind: 'comment' as const, messageId: 'msg' };
    await expect(controller.incorporate('org', 'conv', 'key', body, new Set())).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.incorporate('other', 'conv', 'key', body, 'ALL')).rejects.toBeInstanceOf(NotFoundException);
    expect(service.incorporateWorkbench).not.toHaveBeenCalled();
    expect(service.incorporateGroup).not.toHaveBeenCalled();
    expect(await controller.incorporate('org', 'conv', 'key', body, new Set(['channel']))).toEqual({ ok: true });
  });
});
