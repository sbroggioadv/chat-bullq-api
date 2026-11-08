import axios from 'axios';
import { CalendarService } from './calendar.service';
import { ChannelAccessService } from '../iam/channel-access/channel-access.service';
import { BadGatewayException, ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
jest.mock('axios');
const now = new Date('2026-11-08T12:00:00Z');
function setup() {
  const db = {
    conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'c1', channelId: 'wa', metadata: {} }), update: jest.fn() },
    message: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn().mockResolvedValue({ id: 'bubble' }) },
    channel: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn() },
  };
  const get = jest.fn(), post = jest.fn();
  (axios.create as jest.Mock).mockReturnValue({ get, post });
  const gmail = { accessToken: jest.fn().mockResolvedValue('fake-token') };
  const service = new CalendarService(db as never, new ChannelAccessService(db as never), gmail as never);
  const bubble = { id: 'bubble', createdAt: now, content: { text: '📅 Reunião agendada: Consulta\nQuando: 08/11/2026, 15:00\nMeet: https://meet.google.com/abc' }, metadata: { kind: 'calendar_scheduled', calendarEventId: 'ev', calendarId: 'primary' } };
  const channel = { id: 'gmail', organizationId: 'org', type: 'GMAIL', isActive: true, config: { hasCalendar: true } };
  return { db, get, post, service, bubble, channel, gmail };
}
describe('Calendar conversation meeting history', () => {
  it('returns disconnected empty history', async () => {
    const { service } = setup(); expect(await service.conversationMeetings('c1', 'org', 'ALL')).toEqual({ connected: false, items: [] });
  });
  it('reads legacy SYSTEM bubbles when disconnected', async () => {
    const { service, db, bubble, gmail } = setup(); db.message.findMany.mockResolvedValue([bubble]);
    const result = await service.conversationMeetings('c1', 'org', 'ALL');
    expect(result.items[0]).toMatchObject({ eventId: 'ev', title: 'Consulta', start: '08/11/2026, 15:00', end: null, attendees: [], meetLink: 'https://meet.google.com/abc', status: 'unknown' });
    expect(gmail.accessToken).not.toHaveBeenCalled();
  });
  it('refreshes the exact linked Google event instead of listing unrelated events', async () => {
    const { service, db, bubble, channel, get } = setup(); db.message.findMany.mockResolvedValue([bubble]); db.channel.findMany.mockResolvedValue([channel]);
    get.mockResolvedValue({ data: { id: 'ev', summary: 'Alterada', start: { dateTime: '2026-11-09T15:00:00-03:00' }, end: { dateTime: '2026-11-09T16:00:00-03:00' }, attendees: [{ email: 'a@example.test' }], status: 'confirmed' } });
    expect(await service.conversationMeetings('c1', 'org', 'ALL')).toMatchObject({ connected: true, items: [{ title: 'Alterada', attendees: ['a@example.test'], status: 'confirmed' }] });
    expect(get).toHaveBeenCalledWith('/calendars/primary/events/ev');
  });
  it('locates legacy events across accessible calendars without assuming a deleted event', async () => {
    const { service, db, bubble, channel, get } = setup(); db.message.findMany.mockResolvedValue([bubble]); db.channel.findMany.mockResolvedValue([channel, { ...channel, id: 'second' }]);
    get.mockRejectedValueOnce({ response: { status: 404 } }).mockResolvedValueOnce({ data: { summary: 'No segundo calendário', status: 'confirmed' } });
    expect((await service.conversationMeetings('c1', 'org', 'ALL')).items[0].title).toBe('No segundo calendário');
    expect(get).toHaveBeenCalledTimes(2);
  });
  it('never uses a calendar channel the member cannot access', async () => {
    const { service, db, bubble, channel, get } = setup(); db.message.findMany.mockResolvedValue([{ ...bubble, metadata: { ...bubble.metadata, calendarChannelId: 'gmail' } }]); db.channel.findMany.mockResolvedValue([channel]);
    expect(await service.conversationMeetings('c1', 'org', new Set(['wa']))).toMatchObject({ connected: false }); expect(get).not.toHaveBeenCalled();
  });
  it('maps deleted Google events to cancelled, and exposes provider failures', async () => {
    const { service, db, bubble, channel, get } = setup(); db.message.findMany.mockResolvedValue([{ ...bubble, metadata: { ...bubble.metadata, calendarChannelId: 'gmail' } }]); db.channel.findMany.mockResolvedValue([channel]);
    get.mockRejectedValueOnce({ response: { status: 404 } });
    expect((await service.conversationMeetings('c1', 'org', 'ALL')).items[0].status).toBe('cancelled');
    get.mockRejectedValueOnce({ response: { status: 500 } }); await expect(service.conversationMeetings('c1', 'org', 'ALL')).rejects.toBeInstanceOf(BadGatewayException);
  });
  it('refuses missing, inaccessible and merged conversations before Google', async () => {
    const { service, db, get } = setup(); db.conversation.findFirst.mockResolvedValueOnce(null);
    await expect(service.conversationMeetings('c1', 'other', 'ALL')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.conversationMeetings('c1', 'org', new Set())).rejects.toBeInstanceOf(ForbiddenException);
    db.conversation.findFirst.mockResolvedValue({ id: 'c1', channelId: 'wa', metadata: { cleanup_merged_into: 'original' } });
    await expect(service.conversationMeetings('c1', 'org', 'ALL')).rejects.toBeInstanceOf(UnprocessableEntityException); expect(get).not.toHaveBeenCalled();
  });
  it('persists complete event snapshot and calendar identity in new bubbles', async () => {
    const { service, db, channel, post } = setup(); db.channel.findFirst.mockResolvedValue(channel);
    post.mockResolvedValue({ data: { id: 'ev', summary: 'Consulta', start: { dateTime: '2026-11-09T15:00:00Z' }, end: { dateTime: '2026-11-09T16:00:00Z' }, status: 'confirmed' } });
    await service.createEventFromConversation('org', 'ALL', { conversationId: 'c1', channelId: 'gmail', summary: 'Consulta', startIso: '2026-11-09T15:00:00Z', endIso: '2026-11-09T16:00:00Z', attendeeEmails: ['a@example.test'] });
    expect(db.message.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ metadata: expect.objectContaining({ eventId: 'ev', calendarChannelId: 'gmail', title: 'Consulta', start: '2026-11-09T15:00:00Z', end: '2026-11-09T16:00:00Z', attendees: ['a@example.test'], status: 'confirmed' }) }) }));
  });
});
