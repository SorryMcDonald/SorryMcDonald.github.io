import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.js';

describe('server bootstrap', () => {
  it('serves a health response without a real database', async () => {
    const app = await buildApp({ logger: false, db: { query: async () => ({ rows: [] }) } });
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    await app.close();
  });
});
