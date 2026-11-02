import axios from 'axios';
import { InstagramHttpClient } from './instagram.http-client';

jest.mock('axios');
describe('InstagramHttpClient.getUserProfile', () => {
  it('logs HTTP failures without secrets or profile data and returns null', async () => {
    const get = jest.fn().mockRejectedValue({ response: { status: 429, data: { error: { message: 'secret profile' } } }, message: 'token secret' });
    (axios.create as jest.Mock).mockReturnValue({ get });
    const client = new InstagramHttpClient();
    const warn = jest.spyOn((client as any).logger, 'warn').mockImplementation();
    expect(await client.getUserProfile({ config: { accessToken: 'secret', igBusinessId: 'business' } } as any, '12345678')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    for (const [message] of warn.mock.calls) {
      expect(message).toMatch(/429/);
      expect(message).not.toMatch(/secret|12345678|profile/i);
    }
  });
  it('logs safe Meta error diagnostics and suppresses direct failures when identity is known', async () => {
    const error = { response: { status: 400, data: { error: { code: 230, error_subcode: 12, type: 'IGApiException', fbtrace_id: 'Trace123', message: 'secret profile 12345678' } } } };
    const get = jest.fn().mockRejectedValue(error);
    (axios.create as jest.Mock).mockReturnValue({ get });
    const client = new InstagramHttpClient();
    const warn = jest.spyOn((client as any).logger, 'warn').mockImplementation();
    await client.getUserProfile({ config: { accessToken: 'secret', igBusinessId: 'business' } } as any, '12345678');
    expect(warn).toHaveBeenCalledTimes(2);
    for (const [message] of warn.mock.calls) {
      expect(message).toMatch(/230/); expect(message).toMatch(/12/); expect(message).toMatch(/IGApiException/); expect(message).toMatch(/Trace123/);
      expect(message).not.toMatch(/secret|12345678|profile/i);
    }
    warn.mockClear();
    get.mockResolvedValueOnce({ data: { data: [{ participants: { data: [{ id: '12345678', username: 'person', name: 'Person' }] } }] } }).mockRejectedValueOnce(error);
    await client.getUserProfile({ config: { accessToken: 'secret', igBusinessId: 'business' } } as any, '12345678');
    expect(warn).not.toHaveBeenCalled();
  });

});
