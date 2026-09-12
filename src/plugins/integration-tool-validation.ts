import type { ConnectionGrant, OperationDefinition } from '../domain/capabilities.js';
import type { JsonValue } from '../domain/contracts.js';

export const MAX_TOOL_RESULT_BYTES = 128 * 1024;

export function enforceResourceConstraints(
  grant: ConnectionGrant,
  input: { [key: string]: JsonValue },
): void {
  for (const [field, allowed] of Object.entries(grant.resourceConstraints ?? {})) {
    const actual = input[field];
    const selected = typeof actual === 'string'
      ? [actual]
      : Array.isArray(actual) && actual.every((value) => typeof value === 'string')
        ? actual as string[]
        : undefined;
    if (!selected || selected.some((value) => !allowed.includes(value))) {
      throw new Error(`integration input ${field} is outside the connection resource grant`);
    }
  }
}

export function recordValue(value: JsonValue, label: string): { [key: string]: JsonValue } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

export function operationInputValue(
  argumentsValue: { [key: string]: JsonValue },
  operation: OperationDefinition,
): { [key: string]: JsonValue } {
  if (argumentsValue.input !== undefined) {
    return recordValue(argumentsValue.input, 'integration operation input');
  }

  const flatInput = Object.fromEntries(
    Object.entries(argumentsValue).filter(([key]) => key !== 'account'),
  );
  const schema = operation.inputSchema && recordValue(operation.inputSchema, 'integration operation schema');
  if (!schema || schema.type !== 'object') {
    throw new Error('integration tool arguments require an input object');
  }
  const properties = schema.properties === undefined
    ? undefined
    : recordValue(schema.properties, 'integration operation properties');
  if (
    schema.additionalProperties === false &&
    Object.keys(flatInput).some((key) => properties?.[key] === undefined)
  ) {
    throw new Error('integration tool arguments require an input object');
  }
  return flatInput;
}

export function stringValue(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label} is required`);
  return value;
}

export function assertBoundedJson(value: JsonValue, label: string): void {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error(`${label} is not JSON`);
  }
  if (Buffer.byteLength(encoded) > MAX_TOOL_RESULT_BYTES) {
    throw new Error(`${label} exceeds ${MAX_TOOL_RESULT_BYTES} bytes`);
  }
}
