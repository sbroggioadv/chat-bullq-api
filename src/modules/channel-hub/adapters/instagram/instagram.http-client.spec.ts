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
});
