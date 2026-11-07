import { Ajv } from 'ajv';
import schema from '../../spec/schemas/agents-api.schema.json' with { type: 'json' };
import { describe, expect, it } from 'vitest';
import { AgentsApiError, parseAgentsContract } from '../../src/domain/agents-api-validation.js';
import type { AgentsApiContracts } from '../../src/domain/agents-api.js';

const ajv = new Ajv({ strict: false, allErrors: false });
ajv.addSchema(schema);

const examples = [
  ['Trace', { id: 'trace-1', object: 'agent.session.trace', session_id: 'session-1', turn_id: 'turn-1', otlp: { resourceSpans: [] } }],
  ['SessionCreate', { environment: { type: 'none' }, agent: { model: 'test-model' }, input: '' }],
  ['SessionEvents', { events: [{ type: 'agent.session.input.cancel' }] }],
  ['SessionEvents', { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: '' }] }] }] }],
] as const;

describe('parseAgentsContract precompiled parity', () => {
  it('matches dynamic validation and first errors for every contract on boundary values', () => {
    for (const name of Object.keys(schema.definitions.AgentsApiContracts.properties) as (keyof AgentsApiContracts)[]) {
      const dynamic = ajv.compile({ $ref: `${schema.$id}#/definitions/AgentsApiContracts/properties/${name}` });
      for (const value of [undefined, null, false, 0, '', [], {}, { limit: 0 }, { limit: 1 }, { limit: '1' }, { unexpected: true }]) {
        const before = structuredClone(value);
        if (dynamic(value)) expect(parseAgentsContract(name, value)).toBe(value);
        else {
          const first = dynamic.errors?.[0];
          expect(() => parseAgentsContract(name, value)).toThrow(new AgentsApiError(400,
            `Invalid ${name}: ${first?.message ?? 'invalid request'}.`, 'invalid_request',
            first?.instancePath.replace(/^\//, '').replaceAll('/', '.') || null));
        }
        expect(value).toEqual(before);
      }
    }
  });
  it('matches dynamic AJV acceptance, rejection, first error, and public error fields', () => {
    for (const [name, valid] of examples) {
      const dynamic = ajv.compile({ $ref: `${schema.$id}#/definitions/AgentsApiContracts/properties/${name}` });
      const invalid = { ...valid, unexpected: true };
      expect(parseAgentsContract(name, valid)).toBe(valid);
      expect(dynamic(valid)).toBe(true);
      expect(dynamic(invalid)).toBe(false);

      let error: unknown;
      try { parseAgentsContract(name, invalid); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(AgentsApiError);
      const publicError = error as AgentsApiError;
      expect(publicError.status).toBe(400);
      expect(publicError.code).toBe('invalid_request');
      expect(publicError.param).toBe(dynamic.errors?.[0]?.instancePath.replace(/^\//, '').replaceAll('/', '.') || null);
      expect(publicError.message).toBe(`Invalid ${name}: ${dynamic.errors?.[0]?.message ?? 'invalid request'}.`);
    }

    for (const [name, invalid] of [
      ['Trace', { id: 'trace-1', object: 'agent.session.trace', session_id: 'session-1', turn_id: 'turn-1', otlp: {} }],
      ['SessionEvents', { events: [{ type: 'agent.session.input.message', prompt: 'old prompt field' }] }],
      ['SessionEvents', { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 0 }] }] }] }],
      ['SessionEvents', { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello', unexpected: true }] }] }] }],
    ] as const) {
      const dynamic = ajv.compile({ $ref: `${schema.$id}#/definitions/AgentsApiContracts/properties/${name}` });
      expect(dynamic(invalid)).toBe(false);
      let error: unknown;
      try { parseAgentsContract(name, invalid); } catch (caught) { error = caught; }
      const publicError = error as AgentsApiError;
      expect(publicError.message).toBe(`Invalid ${name}: ${dynamic.errors?.[0]?.message ?? 'invalid request'}.`);
      expect(publicError.param).toBe(dynamic.errors?.[0]?.instancePath.replace(/^\//, '').replaceAll('/', '.') || null);
    }
  });

  it('does not mutate or replace accepted input values', () => {
    const value = Object.freeze({
      environment: Object.freeze({ type: 'none' }),
      agent: Object.freeze({ model: 'test-model' }),
      input: '',
      metadata: null,
    });
    const before = structuredClone(value);
    expect(parseAgentsContract('SessionCreate', value)).toBe(value);
    expect(value).toEqual(before);
  });
});
