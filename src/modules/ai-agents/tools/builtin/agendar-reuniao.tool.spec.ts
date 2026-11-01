import { AgendarReuniaoTool } from './agendar-reuniao.tool';
import { GoogleCalendarService } from '../client-ops/google-calendar.service';
import axios from 'axios';

jest.mock('axios');

describe('agendamento sem padrões de cliente', () => {
  const ctx = { organizationId: 'org', conversationId: 'conversation', contactId: 'contact', channelId: 'channel', agentId: 'agent', runId: 'run' };
  const input = { clientName: 'Projeto', tema: 'Reunião', inicioIso: '2099-01-01T10:00:00Z', avisarGrupo: false };

  it('não convida terceiros quando não há configuração nem convidados', async () => {
    const calendar = { createEventWithMeet: jest.fn().mockResolvedValue({ htmlLink: null, meetLink: null }) };
    const hoppe = { isConfigured: () => true, findClientProject: jest.fn().mockResolvedValue({ project: { name: 'Projeto' } }), createMeetingTask: jest.fn().mockResolvedValue({ taskName: 'Reunião', taskId: 'task' }) };
    const tool = new AgendarReuniaoTool({ get: () => undefined } as any, hoppe as any, { hasOAuth: () => true } as any, calendar as any, {} as any);
    await tool.execute(input, ctx);
    expect(calendar.createEventWithMeet).toHaveBeenCalledWith(expect.objectContaining({ attendeeEmails: [], description: 'Reunião agendada pela Sofia. Projeto: Projeto.' }));
  });

  it('preserva convidados configurados e informados', async () => {
    const calendar = { createEventWithMeet: jest.fn().mockResolvedValue({ htmlLink: null, meetLink: null }) };
    const hoppe = { isConfigured: () => true, findClientProject: jest.fn().mockResolvedValue({ project: { name: 'Projeto' } }), createMeetingTask: jest.fn().mockResolvedValue({ taskName: 'Reunião', taskId: 'task' }) };
    const tool = new AgendarReuniaoTool({ get: () => 'team@example.test' } as any, hoppe as any, { hasOAuth: () => true } as any, calendar as any, {} as any);
    await tool.execute({ ...input, emailsConvidados: ['guest@example.test'] }, ctx);
    expect(calendar.createEventWithMeet).toHaveBeenCalledWith(expect.objectContaining({ attendeeEmails: ['team@example.test', 'guest@example.test'] }));
  });

  it('usa a agenda primária da conta configurada quando não há id de agenda', async () => {
    const post = axios.post as jest.Mock;
    post.mockResolvedValue({ data: { id: 'event' } });
    const service = new GoogleCalendarService({ get: () => undefined } as any, { getCalendarToken: async () => 'synthetic' } as any);
    await service.createEventWithMeet({ summary: 'Reunião', startIso: input.inicioIso, endIso: input.inicioIso, attendeeEmails: [] });
    expect(post.mock.calls[0][0]).toContain('/calendars/primary/events');
  });
});
