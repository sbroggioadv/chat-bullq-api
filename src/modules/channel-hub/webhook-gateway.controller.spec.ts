import { ChannelType } from '@prisma/client';
import { WebhookGatewayController } from './webhook-gateway.controller';

describe('roteamento do webhook entre espaços', () => {
  function setup(channels: any[]) {
    const adapter = { extractLocators: () => [{ instanceId: 'same' }], matchesChannel: () => true, validateWebhook: jest.fn(() => true), parseWebhook: jest.fn(() => ({ messages: [{ externalMessageId: 'msg' }], statuses: [] })) };
    const registry = { hasAdapter: () => true, getInbound: () => adapter };
    const service = { findActiveByType: jest.fn(async () => channels), resolveByLocator: jest.fn(async () => channels[0]) };
    const events = { record: jest.fn(async () => 'event'), recordUnrouted: jest.fn() };
    const queue = { add: jest.fn() };
    const controller = new WebhookGatewayController(registry as any, service as any, events as any, queue as any);
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    return { controller, res, queue, adapter, events };
  }
  const channel = (id: string, organizationId: string) => ({ id, organizationId, config: {} });
  it('descarta evento ambíguo em organizações diferentes e responde 200', async () => {
    const t = setup([channel('a', 'A'), channel('b', 'B')]);
    await t.controller.handleWebhook(ChannelType.WHATSAPP_ZAPPFY, { headers: {}, body: {} } as any, t.res as any);
    expect(t.res.status).toHaveBeenCalledWith(200);
    expect(t.queue.add).not.toHaveBeenCalled();
    expect(t.events.record).not.toHaveBeenCalled();
  });
  it('entrega normalmente quando há apenas um canal compatível', async () => {
    const t = setup([channel('a', 'A')]);
    await t.controller.handleWebhook(ChannelType.WHATSAPP_ZAPPFY, { headers: {}, body: {} } as any, t.res as any);
    expect(t.queue.add).toHaveBeenCalledWith('process-inbound', expect.objectContaining({ channelId: 'a', organizationId: 'A' }), expect.anything());
  });
  it('recusa Gmail com locator em organizações diferentes', async () => {
    const t = setup([channel('a', 'A'), channel('b', 'B')]);
    await t.controller.handleWebhook(ChannelType.GMAIL, { headers: {}, body: {} } as any, t.res as any);
    expect(t.res.json).toHaveBeenCalledWith({ status: 'ambiguous_channel' });
    expect(t.queue.add).not.toHaveBeenCalled();
  });
  it('processa Gmail com canais na mesma organização', async () => {
    const t = setup([channel('a', 'A'), channel('b', 'A')]);
    await t.controller.handleWebhook(ChannelType.GMAIL, { headers: {}, body: {} } as any, t.res as any);
    expect(t.queue.add).toHaveBeenCalledWith('process-inbound', expect.objectContaining({ organizationId: 'A' }), expect.anything());
  });

});
