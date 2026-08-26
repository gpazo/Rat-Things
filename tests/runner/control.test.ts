import { describe, expect, it } from 'vitest';
import { isApprovalRequest } from '../../src/runner/control.js';

describe('runner approval protocol rejection', () => {
  it('recognizes current and legacy approval requests without classifying ordinary input', () => {
    expect(isApprovalRequest('item/commandExecution/requestApproval')).toBe(true);
    expect(isApprovalRequest('item/fileChange/requestApproval')).toBe(true);
    expect(isApprovalRequest('execCommandApproval')).toBe(true);
    expect(isApprovalRequest('applyPatchApproval')).toBe(true);
    expect(isApprovalRequest('item/tool/requestUserInput')).toBe(false);
  });
});
