import type { AgentResource } from '../core/agents-ports.js';
import type { SpaceRole } from '../domain/api-permissions.js';

export type InviteRole = Exclude<SpaceRole, 'manager'>;
export interface SpaceInvite {
  id: string;
  space_id: string;
  role: InviteRole;
  label?: string;
  created_by: string;
  created_at: number;
  expires_at: number;
  status: 'active' | 'redeemed' | 'revoked';
  redeemed_by?: string;
  redeemed_at?: number;
}
export interface SpaceInviteGeneration { space_id: string }

export const ACTIVE_INVITE_LIMIT = 50;
export const INVITE_GENERATIONS = 'space_invite_generations';

export function isActiveSpaceInvite(
  invite: Pick<SpaceInvite, 'status' | 'expires_at'>,
  now: number,
): boolean {
  return invite.status === 'active' && invite.expires_at > now;
}

export function planInviteGeneration(
  ownerId: string,
  spaceId: string,
  now: number,
  current?: AgentResource<SpaceInviteGeneration>,
) {
  const expectedRevision = current?.revision ?? 0;
  return {
    expectedRevision,
    resource: {
      ownerId,
      collection: INVITE_GENERATIONS,
      id: 'active',
      createdAt: current?.createdAt ?? now,
      revision: expectedRevision + 1,
      value: { space_id: spaceId },
    },
  };
}
