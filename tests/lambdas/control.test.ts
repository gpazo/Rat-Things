import { describe, expect, it } from 'vitest';
import { apiRequestBody } from '../../src/lambdas/control.js';

describe('control API request normalization', () => {
  it('uses stable trusted source metadata across idempotent API attempts', () => {
    const body = {
      version: '1',
      prompt: 'test',
      source: { kind: 'github', deliveryId: 'untrusted' },
    };

    expect(apiRequestBody(body)).toEqual({
      version: '1',
      prompt: 'test',
      source: { kind: 'api' },
    });
    expect(apiRequestBody(body)).toEqual(apiRequestBody(body));
  });
});
