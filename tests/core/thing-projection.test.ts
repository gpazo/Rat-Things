import { describe, expect, it } from 'vitest';
import { explainThing, publicThingSummary } from '../../src/core/thing-projection.js';
import type { PublicThing, ThingRecord, ThingRevision } from '../../src/domain/things.js';

const timestamp = '2026-08-21T11:00:00.000Z';
const revision: ThingRevision = {
  revision: 1, name: 'Example', trigger: { kind: 'schedule', expression: 'rate(1 hour)' },
  spec: { bucket: 'private-definitions', key: 'owner-scoped-spec', sha256: 'a'.repeat(64) },
  specHash: 'b'.repeat(64), createdAt: timestamp,
};

describe('Thing projections', () => {
  it('omits private coordinates and retains independent copies of public mutable fields', () => {
    const record: ThingRecord = {
      version: '1', thingId: 'thing-1', ownerId: 'owner-1', ownerCreated: `owner-1#${timestamp}#thing-1`,
      status: 'active', draft: revision, active: revision,
      triggerState: { status: 'ready', revision: 1, updatedAt: timestamp },
      createdAt: timestamp, updatedAt: timestamp,
    };
    const before = structuredClone(record);
    const summary = publicThingSummary(record);
    expect(summary.hasUnpublishedChanges).toBe(false);
    expect(summary).not.toHaveProperty('ownerId');
    expect(summary).not.toHaveProperty('ownerCreated');
    expect(summary.draft).not.toHaveProperty('spec');
    expect(summary.active).not.toHaveProperty('spec');
    summary.draft.trigger.kind = 'manual';
    summary.triggerState.status = 'error';
    expect(record).toEqual(before);
    expect(summary.active?.trigger.kind).toBe('schedule');
  });

  it('explains an unpublished draft without applying the active revision’s scheduler error to it', () => {
    const thing = publicThing();
    const explanation = explainThing(thing, 'draft');
    expect(explanation.diagnostics.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'spec.valid', status: 'pass' },
      { id: 'lifecycle', status: 'warning' },
      { id: 'trigger', status: 'pass' },
      { id: 'connections', status: 'pass' },
    ]);
    expect(explanation.compiledRun.prompt).toBe('Draft goal');
    expect(explainThing(thing, 'active').diagnostics.find(({ id }) => id === 'trigger')?.status).toBe('error');
    expect(explainThing({ ...thing, status: 'archived' }, 'draft').runnable).toBe(false);
    const { active: _active, ...unpublished } = thing;
    expect(() => explainThing(unpublished, 'active')).toThrow('no published revision to explain');
  });
});

function publicThing(): PublicThing {
  const { spec: _reference, ...visible } = revision;
  const active = {
    ...visible, version: '1' as const, thingId: 'thing-1',
    spec: { version: '1' as const, name: 'Example', goal: 'Published goal', trigger: revision.trigger },
  };
  return {
    version: '1', thingId: 'thing-1', status: 'active', active,
    draft: { ...active, revision: 2, spec: { ...active.spec, goal: 'Draft goal' } },
    hasUnpublishedChanges: true,
    triggerState: { status: 'error', revision: 1, error: 'Scheduler unavailable', updatedAt: timestamp },
    createdAt: timestamp, updatedAt: timestamp,
  };
}
