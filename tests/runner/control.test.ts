import { describe, expect, it } from 'vitest';
import { approvalResponseFor } from '../../src/runner/control.js';

describe('runner approval response mapping', () => {
  it('maps v2 command and file decisions', () => {
    expect(approvalResponseFor(
      'item/commandExecution/requestApproval',
      'accept-for-session',
    )).toEqual({ decision: 'acceptForSession' });
    expect(approvalResponseFor(
      'item/fileChange/requestApproval',
      'decline',
    )).toEqual({ decision: 'decline' });
  });

  it('maps legacy approvals without weakening a denial', () => {
    expect(approvalResponseFor('execCommandApproval', 'accept')).toEqual({
      decision: 'approved',
    });
    expect(approvalResponseFor('applyPatchApproval', 'decline', 'outside scope')).toEqual({
      decision: { denied: { rejection: 'outside scope' } },
    });
  });

  it('requires an explicit raw response for non-approval requests', () => {
    expect(() => approvalResponseFor(
      'item/tool/requestUserInput',
      'accept',
    )).toThrow('requires an explicit response');
  });
});
