import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../../src/domain/contracts.js';
import {
  assertBoundedJson,
  enforceResourceConstraints,
  operationInputValue,
  recordValue,
} from '../../src/plugins/integration-tool-validation.js';
import { freeze, operation, selected } from './integration-tool-fixtures.js';

describe('integration operation input contracts', () => {
  it('requires object input while retaining valid falsey field values', () => {
    const input = freeze({ active: false, count: 0, empty: '' });
    expect(recordValue(input, 'input')).toBe(input);
    for (const value of [null, false, 0, '', []]) expect(() => recordValue(value, 'input')).toThrow('input must be an object');
    expect(operationInputValue({ input }, operation)).toBe(input);
  });

  it('accepts flat input only with an object schema and rejects unknown fields when additional properties are disabled', () => {
    const input = freeze({ account: 'mail-first', query: 'invoice' });
    expect(operationInputValue(input, operation)).toEqual({ query: 'invoice' });
    expect(() => operationInputValue({ ...input, extra: false }, operation)).toThrow('integration tool arguments require an input object');
    const { inputSchema: _inputSchema, ...withoutSchema } = operation;
    expect(() => operationInputValue(input, withoutSchema)).toThrow('integration tool arguments require an input object');
    expect(() => operationInputValue(input, { ...operation, inputSchema: { type: 'array' } })).toThrow('integration tool arguments require an input object');
    expect(operationInputValue({ extra: false }, { ...operation, inputSchema: { type: 'object' } })).toEqual({ extra: false });
  });

  it('preserves declared falsey schema properties and checks malformed flat schemas only on the flat path', () => {
    const schema = freeze({ type: 'object', properties: { enabled: false, missing: null }, additionalProperties: false });
    expect(operationInputValue({ enabled: false, missing: null }, { ...operation, inputSchema: schema })).toEqual({ enabled: false, missing: null });
    const malformed = { ...operation, inputSchema: { type: 'object', properties: false } };
    expect(() => operationInputValue({}, malformed)).toThrow('integration operation properties must be an object');
    const nested = freeze({ input: {} });
    expect(operationInputValue(nested, malformed)).toBe(nested.input);
  });
});

describe('integration resource constraints', () => {
  it('accepts allowed strings and string arrays, including an explicitly empty selection', () => {
    const grant = freeze({ ...selected('first').grant, resourceConstraints: { folder: ['inbox', 'archive', ''] } });
    for (const folder of ['inbox', '', ['archive', 'inbox'], []]) {
      expect(() => enforceResourceConstraints(grant, freeze({ folder }))).not.toThrow();
    }
    expect(() => enforceResourceConstraints(freeze({ ...grant, resourceConstraints: { folder: [] } }), { folder: [] })).not.toThrow();
    expect(() => enforceResourceConstraints(selected('first').grant, {})).not.toThrow();
  });

  it('rejects missing, mixed-type, or unauthorized resources in grant field order', () => {
    const grant = freeze({ ...selected('first').grant, resourceConstraints: { folder: ['inbox'], account: ['a'] } });
    for (const input of [{}, { folder: false }, { folder: 0 }, { folder: null }, { folder: ['inbox', 0] }, { folder: ['inbox', 'private'] }]) {
      expect(() => enforceResourceConstraints(grant, input)).toThrow('integration input folder is outside the connection resource grant');
    }
    expect(() => enforceResourceConstraints(grant, { folder: 'inbox' })).toThrow('integration input account is outside the connection resource grant');
  });
});

describe('integration result bounds', () => {
  it('includes JSON encoding overhead when bounding UTF-8 bytes', () => {
    expect(() => assertBoundedJson('é'.repeat(65_535), 'result')).not.toThrow();
    expect(() => assertBoundedJson('é'.repeat(65_536), 'result')).toThrow('result exceeds 131072 bytes');
    for (const result of [false, 0, '', null, [], {}]) expect(() => assertBoundedJson(result, 'result')).not.toThrow();
  });

  it('normalizes serialization failures and leaves the original result unchanged', () => {
    const cyclic: { [key: string]: JsonValue } = {};
    cyclic.self = cyclic;
    expect(() => assertBoundedJson(cyclic, 'result')).toThrow('result is not JSON');
    expect(cyclic.self).toBe(cyclic);
    const result = freeze({ values: [0, false, ''] });
    assertBoundedJson(result, 'result');
    expect(result).toEqual({ values: [0, false, ''] });
  });
});
