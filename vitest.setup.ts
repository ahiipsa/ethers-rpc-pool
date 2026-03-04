import { server } from './test/mocks/server.js';
import { beforeAll, afterAll, afterEach } from 'vitest';

beforeAll(() => {
  server.listen();
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});
