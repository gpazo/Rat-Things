import Ajv from 'ajv';
import standaloneCode from 'ajv/dist/standalone/index.js';
import { readFile, writeFile } from 'node:fs/promises';

const schemaPath = 'spec/schemas/agents-api.schema.json';
const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
const contractNames = Object.keys(schema.definitions.AgentsApiContracts.properties);
const ajv = new Ajv({ strict: false, allErrors: false, inlineRefs: false, code: { source: true, esm: true } });
ajv.addSchema(schema);

const schemas = {};
for (const name of contractNames) {
  const exportName = `validate${name}`;
  schemas[exportName] = exportName;
  ajv.addSchema({
    $id: exportName,
    $ref: `${schema.$id}#/definitions/AgentsApiContracts/properties/${name}`,
  }, exportName);
}

const source = standaloneCode(ajv, schemas);
const map = `\nexport const validators = {\n${contractNames.map((name) => `  ${JSON.stringify(name)}: validate${name},`).join('\n')}\n};\n`;
const header = '// Generated from spec/schemas/agents-api.schema.json by scripts/generate-agents-api-validators.mjs. Do not edit.\n';
const generated = `${header}${source}${map}`;
const declaration = `${header}import type { ValidateFunction } from 'ajv';\nimport type { AgentsApiContracts } from './agents-api.js';\n${contractNames.map((name) => `export declare const validate${name}: ValidateFunction;`).join('\n')}\nexport declare const validators: Readonly<Record<keyof AgentsApiContracts, ValidateFunction>>;\n`;
const outputPath = 'src/domain/agents-api-validators.generated.mjs';
const declarationPath = 'src/domain/agents-api-validators.generated.d.mts';

if (process.argv.includes('--check')) {
  if (await readFile(outputPath, 'utf8').catch(() => '') !== generated
    || await readFile(declarationPath, 'utf8').catch(() => '') !== declaration) {
    throw new Error('Agents API validators are stale; run npm run agents-api:validators');
  }
} else {
  await writeFile(outputPath, generated);
  await writeFile(declarationPath, declaration);
}
