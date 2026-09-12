import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../../src/domain/contracts.js';
import {
  assertUniqueConnectionAliases,
  connectionsByPlugin,
  defaultConnectionFor,
  resolveToolCall,
  toolInputSchema,
  toolName,
  type ResolvedTool,
} from '../../src/plugins/integration-tool-planning.js';
import { freeze, operation, selected } from './integration-tool-fixtures.js';

describe('integration tool planning', () => {
  const first = freeze(selected('first'));
  const second = freeze(selected('second'));

  it('groups into fresh arrays in plugin and account order without changing the selection', () => {
    const billing = freeze(selected('shop', 'billing'));
    const input = freeze([first, billing, second]);
    const grouped = connectionsByPlugin(input);
    expect([...grouped.keys()]).toEqual(['mail', 'billing']);
    expect(grouped.get('mail')).toEqual([first, second]);
    grouped.get('mail')!.pop();
    expect(input).toEqual([first, billing, second]);
    expect(connectionsByPlugin([]).size).toBe(0);
  });

  it('reports the first duplicate alias without treating identical aliases in different plugins as distinct', () => {
    expect(() => assertUniqueConnectionAliases(freeze([first, second]))).not.toThrow();
    expect(() => assertUniqueConnectionAliases(freeze([first, second, selected('billing', 'billing', first.connection.alias), second])))
      .toThrow(`duplicate connection alias ${first.connection.alias}`);
  });

  it('gives exact operation defaults priority and does not fall through from an unauthorized configured default', () => {
    const accounts = freeze([first, second]);
    expect(defaultConnectionFor(operation, accounts, { [operation.id]: 'second', mail: 'first' })).toBe(second);
    expect(defaultConnectionFor(operation, accounts, { mail: 'first' })).toBe(first);
    expect(defaultConnectionFor(operation, [first], { [operation.id]: 'not-allowed', mail: 'first' })).toBeUndefined();
    expect(defaultConnectionFor(operation, [first], { mail: 'not-allowed' })).toBeUndefined();
    expect(defaultConnectionFor(operation, accounts, { [operation.id]: '', mail: 'first' })).toBe(first);
  });

  it('uses a unique eligible capability default, otherwise requires an unambiguous account', () => {
    expect(defaultConnectionFor(operation, [first, second], { messaging: 'second', billing: 'not-allowed' })).toBe(second);
    expect(defaultConnectionFor(operation, [first, second], { messaging: 'first', other: 'second' })).toBeUndefined();
    expect(defaultConnectionFor(operation, [first, second], {})).toBeUndefined();
    expect(defaultConnectionFor(operation, [first], {})).toBe(first);
    expect(defaultConnectionFor(operation, [], {})).toBeUndefined();
  });

  it('projects only account aliases and the supplied input schema with optional default selection', () => {
    const schema = toolInputSchema(freeze(operation), freeze([first, second]), second);
    expect(schema).toEqual({
      type: 'object', properties: {
        account: { type: 'string', description: 'The connected account alias to use. Defaults to mail-second.', enum: ['mail-first', 'mail-second'], default: 'mail-second' },
        input: operation.inputSchema,
      }, required: ['input'], additionalProperties: false,
    });
    expect(JSON.stringify(schema)).not.toMatch(/owner-1|grant-first|oauth2/);
    expect(toolInputSchema(operation, [first, second]).required).toEqual(['account', 'input']);
    const { inputSchema: _inputSchema, ...withoutSchema } = operation;
    expect(toolInputSchema(withoutSchema, [first])).toMatchObject({ properties: { input: { type: 'object', additionalProperties: true } } });
    expect(toolName('mail.messages-search', 'mail')).toBe('messages_search');
    expect(toolName(operation.id, 'mail')).toBe('messages_search');
  });
});

describe('integration call resolution', () => {
  const first = freeze(selected('first'));
  const second = freeze(selected('second'));
  const definition = freeze({ operation, connections: [first, second], defaultConnection: first });
  const tools: ReadonlyMap<string, ResolvedTool> = new Map([['mail:messages_search', definition]]);
  const call = (argumentsValue: JsonValue) => ({ namespace: 'mail', tool: 'messages_search', arguments: argumentsValue });

  it('selects an alias or ID explicitly, otherwise uses the configured default', () => {
    expect(resolveToolCall(tools, call({ account: 'mail-second', input: {} })).selected).toBe(second);
    expect(resolveToolCall(tools, call({ account: 'second', input: {} })).selected).toBe(second);
    expect(resolveToolCall(tools, call({ input: {} })).selected).toBe(first);
    for (const account of ['', null, false, 0]) {
      expect(() => resolveToolCall(tools, call({ account, input: {} }))).toThrow('integration account is required');
    }
  });

  it('retains nested input ownership and creates a new object only for flat input', () => {
    const nested = freeze({ query: 'invoice', enabled: false, limit: 0, cursor: '' });
    expect(resolveToolCall(tools, freeze(call({ input: nested }))).operationInput).toBe(nested);
    const flat = freeze({ account: 'mail-first', query: 'invoice' });
    const resolved = resolveToolCall(tools, freeze(call(flat)));
    expect(resolved.operationInput).toEqual({ query: 'invoice' });
    expect(resolved.operationInput).not.toBe(flat);
    expect(flat.account).toBe('mail-first');
    expect(resolved.operation).toBe(operation);
  });

  it('keeps namespace, tool, argument, and account error precedence', () => {
    expect(() => resolveToolCall(tools, { ...call(null), namespace: null })).toThrow('integration tool namespace is required');
    expect(() => resolveToolCall(tools, { ...call(null), tool: 'unknown' })).toThrow('integration tool mail.unknown is not available');
    expect(() => resolveToolCall(tools, call(null))).toThrow('integration tool arguments must be an object');
    expect(() => resolveToolCall(tools, call({ account: 'foreign', input: false }))).toThrow('account foreign is not authorized for this operation');
    expect(() => resolveToolCall(tools, call({ account: 'mail-first', input: false }))).toThrow('integration operation input must be an object');
  });
});
