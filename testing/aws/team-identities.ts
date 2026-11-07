import { randomBytes } from 'node:crypto';
import {
  AdminCreateUserCommand, AdminDeleteUserCommand, AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient, InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';

export interface TeamIdentityFixture {
  user_pool_id: string;
  issuer: string;
  client_id: string;
  login_origin: string;
  redirect_uri: string;
}

export interface TestTeamIdentity {
  issuer: string;
  subject: string;
  username: string;
  loginPassword: string;
  accessToken: string;
  idToken: string;
  accessTokenForRequest(): Promise<string>;
}

/** Disposable provider users; passwords and bearer tokens stay in this controller's memory. */
export async function createTeamIdentities(
  fixture: TeamIdentityFixture,
  region: string,
  labels: readonly string[],
): Promise<{ users: TestTeamIdentity[]; close(): Promise<void> }> {
  if (!fixture.user_pool_id.startsWith(`${region}_`) ||
      fixture.issuer !== `https://cognito-idp.${region}.amazonaws.com/${fixture.user_pool_id}` ||
      !/^[a-z0-9]+$/.test(fixture.client_id)) throw new Error('Use the disposable deployment identity provider.');
  if (labels.some(label => !/^[a-z][a-z0-9-]{0,30}$/.test(label)) || new Set(labels).size !== labels.length) {
    throw new Error('Test identity labels must be distinct bounded names.');
  }
  const client = new CognitoIdentityProviderClient({ region });
  const created: string[] = [];
  const users: TestTeamIdentity[] = [];
  const close = async () => {
    const failures: unknown[] = [];
    const cleanup = AbortSignal.timeout(60_000);
    for (const username of created) {
      try { await client.send(new AdminDeleteUserCommand({ UserPoolId: fixture.user_pool_id, Username: username }), { abortSignal: AbortSignal.any([cleanup, AbortSignal.timeout(30_000)]) }); }
      catch (error) {
        if (!(error instanceof Error) || !['UserNotFoundException', 'ResourceNotFoundException'].includes(error.name)) failures.push(error);
      }
    }
    client.destroy();
    if (failures.length) throw new Error(`Could not confirm removal of ${failures.length} disposable team identities.`);
  };
  try {
    for (const label of labels) {
      const username = `${label}-${randomBytes(10).toString('hex')}`;
      const password = `${randomBytes(32).toString('base64url')}aA9!`;
      created.push(username);
      const user = await client.send(new AdminCreateUserCommand({
        UserPoolId: fixture.user_pool_id, Username: username, MessageAction: 'SUPPRESS',
        TemporaryPassword: password,
      }), { abortSignal: AbortSignal.timeout(30_000) });
      const subject = user.User?.Attributes?.find(attribute => attribute.Name === 'sub')?.Value;
      if (!subject) throw new Error('The disposable identity provider did not return a subject.');
      await client.send(new AdminSetUserPasswordCommand({
        UserPoolId: fixture.user_pool_id, Username: username, Password: password, Permanent: true,
      }), { abortSignal: AbortSignal.timeout(30_000) });
      const authentication = await client.send(new InitiateAuthCommand({
        ClientId: fixture.client_id, AuthFlow: 'USER_PASSWORD_AUTH',
        AuthParameters: { USERNAME: username, PASSWORD: password },
      }), { abortSignal: AbortSignal.timeout(30_000) });
      const accessToken = authentication.AuthenticationResult?.AccessToken;
      const idToken = authentication.AuthenticationResult?.IdToken;
      if (!accessToken || !idToken || authentication.ChallengeName) throw new Error('Disposable user authentication did not finish.');
      const refreshToken = authentication.AuthenticationResult?.RefreshToken;
      let current = accessToken;
      let expiresAt = Date.now() + (authentication.AuthenticationResult?.ExpiresIn ?? 0) * 1000;
      let refreshing: Promise<string> | undefined;
      const accessTokenForRequest = async (): Promise<string> => {
        if (expiresAt > Date.now() + 60_000) return current;
        if (!refreshToken) throw new Error('The disposable identity cannot refresh its access token.');
        refreshing ??= client.send(new InitiateAuthCommand({
          ClientId: fixture.client_id, AuthFlow: 'REFRESH_TOKEN_AUTH',
          AuthParameters: { REFRESH_TOKEN: refreshToken },
        }), { abortSignal: AbortSignal.timeout(30_000) }).then(result => {
          if (!result.AuthenticationResult?.AccessToken || !result.AuthenticationResult.ExpiresIn || result.ChallengeName) {
            throw new Error('Disposable identity refresh did not finish.');
          }
          current = result.AuthenticationResult.AccessToken;
          expiresAt = Date.now() + result.AuthenticationResult.ExpiresIn * 1000;
          return current;
        }).finally(() => { refreshing = undefined; });
        return refreshing;
      };
      users.push({ issuer: fixture.issuer, subject, username, loginPassword: password, accessToken, idToken, accessTokenForRequest });
    }
    return { users, close };
  } catch (error) {
    await close();
    throw error;
  }
}
