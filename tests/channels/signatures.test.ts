import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  header,
  verifyGitHubSignature,
  verifyGitLabToken,
  verifyGitLabStandardSignature,
  verifySlackSignature,
  verifyTeamsSignature,
} from '../../src/channels/signatures.js';

describe('provider signature verification', () => {
  const body = JSON.stringify({ prompt: 'Review this 🚀' });

  it('verifies GitHub sha256 signatures over the exact request body', () => {
    const secret = 'github-webhook-secret';
    const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

    expect(verifyGitHubSignature(body, signature, secret)).toBe(true);
    expect(verifyGitHubSignature(`${body}\n`, signature, secret)).toBe(false);
    expect(verifyGitHubSignature(body, signature.replace(/.$/, '0'), secret)).toBe(false);
    expect(verifyGitHubSignature(body, signature.slice('sha256='.length), secret)).toBe(false);
    expect(verifyGitHubSignature(body, undefined, secret)).toBe(false);
  });

  it('verifies GitLab tokens and rejects missing or mismatched values', () => {
    expect(verifyGitLabToken('gitlab-secret', 'gitlab-secret')).toBe(true);
    expect(verifyGitLabToken('gitlab-secreu', 'gitlab-secret')).toBe(false);
    expect(verifyGitLabToken('short', 'gitlab-secret')).toBe(false);
    expect(verifyGitLabToken(undefined, 'gitlab-secret')).toBe(false);
  });

  it('verifies GitLab Standard Webhooks signatures and rejects replays', () => {
    const timestamp = '1_800_000_000'.replaceAll('_', '');
    const messageId = 'message-123';
    const key = Buffer.alloc(32, 7);
    const token = `whsec_${key.toString('base64')}`;
    const signature = createHmac('sha256', key)
      .update(`${messageId}.${timestamp}.${body}`)
      .digest('base64');
    expect(verifyGitLabStandardSignature(
      body,
      messageId,
      timestamp,
      `v1,older v1,${signature}`,
      token,
      Number(timestamp),
    )).toBe(true);
    expect(verifyGitLabStandardSignature(
      body,
      messageId,
      timestamp,
      `v1,${signature}`,
      token,
      Number(timestamp) + 301,
    )).toBe(false);
    expect(verifyGitLabStandardSignature(
      `${body} `,
      messageId,
      timestamp,
      `v1,${signature}`,
      token,
      Number(timestamp),
    )).toBe(false);
    expect(verifyGitLabStandardSignature(
      body,
      messageId,
      timestamp,
      `v1,${signature}`,
      `whsec_!!${key.toString('base64')}`,
      Number(timestamp),
    )).toBe(false);
  });

  it('verifies Teams HMAC authorization using a base64-encoded key', () => {
    const key = Buffer.from('teams-shared-secret');
    const signature = createHmac('sha256', key).update(body, 'utf8').digest('base64');

    expect(verifyTeamsSignature(body, `HMAC ${signature}`, key.toString('base64'))).toBe(true);
    expect(verifyTeamsSignature(body, `hmac ${signature}`, key.toString('base64'))).toBe(true);
    expect(verifyTeamsSignature(`${body} `, `HMAC ${signature}`, key.toString('base64'))).toBe(false);
    expect(verifyTeamsSignature(body, `Bearer ${signature}`, key.toString('base64'))).toBe(false);
    expect(verifyTeamsSignature(body, undefined, key.toString('base64'))).toBe(false);
    expect(verifyTeamsSignature(body, `HMAC ${signature}`, '')).toBe(false);
    expect(verifyTeamsSignature(body, `HMAC ${signature}`, `!!${key.toString('base64')}!!`)).toBe(false);
  });

  it('verifies Slack v0 signatures only inside the replay window', () => {
    const signingSecret = 'slack-signing-secret';
    const now = 1_750_000_000;
    const timestamp = String(now - 300);
    const signature = `v0=${createHmac('sha256', signingSecret)
      .update(`v0:${timestamp}:${body}`)
      .digest('hex')}`;

    expect(verifySlackSignature(body, timestamp, signature, signingSecret, now)).toBe(true);
    expect(verifySlackSignature(body, String(now - 301), signature, signingSecret, now)).toBe(false);
    expect(verifySlackSignature(body, String(now + 301), signature, signingSecret, now)).toBe(false);
    expect(verifySlackSignature(body, 'not-a-number', signature, signingSecret, now)).toBe(false);
    expect(verifySlackSignature(body, timestamp, `v1=${signature.slice(3)}`, signingSecret, now)).toBe(false);
    expect(verifySlackSignature(`${body}\n`, timestamp, signature, signingSecret, now)).toBe(false);
  });

  it('looks up API Gateway headers case-insensitively', () => {
    expect(header({ 'X-Hub-Signature-256': 'signature' }, 'x-hub-signature-256')).toBe('signature');
    expect(header({ authorization: 'token' }, 'Authorization')).toBe('token');
    expect(header({}, 'missing')).toBeUndefined();
    expect(header(undefined, 'missing')).toBeUndefined();
  });
});
