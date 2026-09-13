import { createGenerator } from 'ts-json-schema-generator';
import { readFile, writeFile } from 'node:fs/promises';

const schema = createGenerator({
  path: 'src/domain/agents-api.ts',
  tsconfig: 'tsconfig.json',
  type: 'AgentsApiContracts',
  expose: 'export',
  jsDoc: 'extended',
  additionalProperties: false,
  skipTypeCheck: true,
}).createSchema('AgentsApiContracts');

const sdk = JSON.parse(await readFile('node_modules/openai/package.json', 'utf8'));
const output = {
  ...schema,
  $id: 'agents-api.schema.json',
  $comment: `Generated from openai@${sdk.version} by scripts/generate-agents-api-schema.mjs. Do not edit.`,
};
const serialized = `${JSON.stringify(output, null, 2)}\n`;
const path = 'spec/schemas/agents-api.schema.json';
if (process.argv.includes('--check')) {
  if (await readFile(path, 'utf8') !== serialized) {
    throw new Error('Agents API schema is stale; run npm run agents-api:schema');
  }
} else {
  await writeFile(path, serialized);
}
