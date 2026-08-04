import { readdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import process from 'node:process';

const root = resolve('src');
const rules = new Map([
  ['domain', new Set(['adapters', 'app', 'channels', 'conversation', 'credentials', 'delivery', 'execution', 'ingress', 'lambdas', 'plugins', 'runner'])],
  ['core', new Set(['adapters', 'app', 'conversation', 'delivery', 'execution', 'ingress', 'lambdas', 'plugins', 'runner'])],
  ['identity', new Set(['adapters', 'app', 'channels', 'conversation', 'credentials', 'delivery', 'execution', 'ingress', 'lambdas', 'plugins', 'runner'])],
  ['credentials', new Set(['adapters', 'app', 'channels', 'conversation', 'delivery', 'execution', 'ingress', 'lambdas', 'plugins', 'runner'])],
  ['channels', new Set(['adapters', 'app', 'conversation', 'credentials', 'delivery', 'execution', 'ingress', 'lambdas', 'plugins', 'runner'])],
  ['conversation', new Set(['adapters', 'app', 'delivery', 'execution', 'ingress', 'lambdas', 'plugins', 'runner'])],
  ['ingress', new Set(['adapters', 'app', 'delivery', 'execution', 'lambdas', 'runner'])],
  ['delivery', new Set(['adapters', 'app', 'execution', 'ingress', 'lambdas', 'runner'])],
  ['execution', new Set(['adapters', 'app', 'delivery', 'ingress', 'lambdas', 'plugins', 'runner'])],
  ['plugins', new Set(['adapters', 'app', 'execution', 'lambdas', 'runner'])],
  ['adapters', new Set(['app', 'lambdas', 'runner'])],
  ['app', new Set(['lambdas'])],
]);

const violations = [];
for (const file of await sourceFiles(root)) {
  const sourceArea = area(file);
  const forbidden = rules.get(sourceArea);
  if (!forbidden) continue;
  const text = await readFile(file, 'utf8');
  for (const specifier of importSpecifiers(text)) {
    if (!specifier.startsWith('.')) continue;
    const target = resolve(dirname(file), specifier.replace(/\.js$/, '.ts'));
    const targetArea = area(target);
    if (forbidden.has(targetArea)) {
      violations.push(`${relative(process.cwd(), file)} must not import ${specifier} (${targetArea})`);
    }
  }
}

if (violations.length > 0) {
  console.error('Architecture boundary violations:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log('Architecture boundaries are valid.');
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  }));
  return files.flat();
}

function area(file) {
  const path = relative(root, file).split(sep);
  return path.length > 1 ? path[0] : '(root)';
}

function importSpecifiers(source) {
  const pattern = /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  return [...source.matchAll(pattern)].map((match) => match[1]).filter(Boolean);
}
