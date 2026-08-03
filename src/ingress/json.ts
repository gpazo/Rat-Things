import { ValidationError } from '../domain/validation.js';

export function parseWebhookJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ValidationError('request body must be valid JSON');
  }
}
