import { Type } from 'typebox';
import AjvModule from 'ajv';
import type { ToolExecutionResult } from '@earendil-works/pi-durable';
import type { PiEffectTool, PiToolEffect } from './pi/protocol.js';

export const PI_MANAGED_TOOLS: readonly PiEffectTool[] = [
  { kind: 'managed', name: 'exec_command', description: 'Run an argument array in the managed workspace.', parameters: Type.Object({ command: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 100 }), cwd: Type.Optional(Type.String()) }, { additionalProperties: false }) },
  ...(['read_file', 'write_file', 'list_files'] as const).map(name => ({ kind: 'managed' as const, name, description: `${name.replaceAll('_', ' ')} in the managed environment.`, parameters: Type.Object({ path: Type.String({ minLength: 1 }), ...(name === 'write_file' ? { content: Type.String({ maxLength: 1024 * 1024 }) } : {}) }, { additionalProperties: false }) })),
];

export type PiManagedOperation =
  | { kind: 'command'; command: string[]; cwd?: string }
  | { kind: 'read' | 'list'; path: string }
  | { kind: 'write'; path: string; content: string };

export interface PiManagedCommandResponse {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const ajv = new AjvModule.default({ strict: false });
const validators = new Map(PI_MANAGED_TOOLS.map(tool => [tool.name, ajv.compile(tool.parameters)]));
const FILE_PROGRAM = `const fs=require('node:fs');const [op,path,data]=process.argv.slice(1);if(op==='read')process.stdout.write(fs.readFileSync(path,'utf8'));else if(op==='write'){fs.writeFileSync(path,data);console.log('Written');}else if(op==='list')console.log(JSON.stringify(fs.readdirSync(path,{withFileTypes:true}).map(e=>({name:e.name,directory:e.isDirectory()}))));else throw Error('Invalid file operation');`;

export function parsePiManagedOperation(request: PiToolEffect): PiManagedOperation {
  if (request.kind !== 'managed' || !validators.get(request.name)?.(request.arguments)) throw new Error('Tool is outside the admitted capability envelope');
  const args = request.arguments;
  switch (request.name) {
    case 'exec_command': return { kind: 'command', command: [...args.command as string[]], ...(typeof args.cwd === 'string' ? { cwd: args.cwd } : {}) };
    case 'read_file': return { kind: 'read', path: args.path as string };
    case 'write_file': return { kind: 'write', path: args.path as string, content: args.content as string };
    case 'list_files': return { kind: 'list', path: args.path as string };
    default: throw new Error('Tool is outside the admitted capability envelope');
  }
}

export function piManagedCommand(operation: PiManagedOperation, nodeBinary: string, workspace: string): { command: string[]; cwd: string } {
  return operation.kind === 'command'
    ? { command: [...operation.command], cwd: operation.cwd ?? workspace }
    : { command: [nodeBinary, '-e', FILE_PROGRAM, operation.kind, operation.path, operation.kind === 'write' ? operation.content : ''], cwd: workspace };
}

export function piManagedResult(operation: PiManagedOperation, response: PiManagedCommandResponse): ToolExecutionResult {
  const isError = response.exitCode !== 0;
  // File stdout is data; successful runtime warnings must not alter its bytes.
  const text = operation.kind === 'command' || isError ? response.stdout + response.stderr : response.stdout;
  return { output: [{ type: 'text', text }], isError };
}
