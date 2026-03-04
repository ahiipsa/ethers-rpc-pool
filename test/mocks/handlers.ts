import { http, HttpResponse } from 'msw';
import { sleep } from '../utils';

export const handlers = [
  http.post('https://api.example.com/timeout/5000', async () => {
    await sleep(5000);
    return HttpResponse.json({
      id: 1,
      result: '0x1',
    });
  }),
];
