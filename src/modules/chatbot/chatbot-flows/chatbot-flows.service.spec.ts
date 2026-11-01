import { NotFoundException } from '@nestjs/common';
import { ChatbotFlowsService } from './chatbot-flows.service';

describe('ChatbotFlowsService organization boundary', () => {
  const repository = {
    findById: jest.fn(),
    countChannelsByOrg: jest.fn(),
    setChannels: jest.fn(),
  };
  let service: ChatbotFlowsService;
  beforeEach(() => {
    jest.resetAllMocks();
    service = new ChatbotFlowsService(repository as any);
    repository.findById.mockImplementation(async (_id, orgId) => orgId === 'org-a' ? { id: 'flow-a', organizationId: 'org-a' } : null);
  });

  it('rejects a foreign flow without exposing its existence', async () => {
    await expect(service.findOne('flow-a', 'org-b')).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.findById).toHaveBeenCalledWith('flow-a', 'org-b');
  });

  it('rejects a foreign channel before replacing links', async () => {
    repository.countChannelsByOrg.mockResolvedValue(0);
    await expect(service.linkChannels('flow-a', 'org-a', ['channel-b'])).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.setChannels).not.toHaveBeenCalled();
    expect(repository.countChannelsByOrg).toHaveBeenCalledWith('org-a', ['channel-b']);
  });

  it('links channels in the same organization', async () => {
    repository.countChannelsByOrg.mockResolvedValue(1);
    await expect(service.linkChannels('flow-a', 'org-a', ['channel-a'])).resolves.toEqual({ id: 'flow-a', organizationId: 'org-a' });
    expect(repository.setChannels).toHaveBeenCalledWith('flow-a', ['channel-a']);
  });
});
