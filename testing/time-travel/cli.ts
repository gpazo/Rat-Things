import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultFixture, type Choice, type Fixture, type Trace } from './model.js';
import { branch, explore, minimize, replay, verifyParent } from './simulator.js';
import { parseChoice, provenance, readTrace, save } from './artifacts.js';
import { demo } from './demo.js';
import { renderReport } from './report.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

const optionsByCommand: Record<string, string[]> = {
  explore: ['seed', 'runs', 'steps', 'out', 'fault-model', 'actors', 'restarts', 'faults', 'json'],
  replay: ['json', 'parent'],
  inspect: ['at', 'json', 'parent'],
  branch: ['at', 'seed', 'steps', 'out', 'json', 'parent', 'choice'],
  minimize: ['attempts', 'out', 'json', 'parent'],
  demo: ['out', 'json'],
};

function argumentsFor(argv: string[]) {
  const commandName = argv[0];
  requireCondition(
    commandName && optionsByCommand[commandName],
    'Usage: sim:commands <explore|replay|inspect|branch|minimize|demo> [options]',
  );
  const options: Record<string, string | true> = {};
  const positionals: string[] = [];
  for (let index = 1; index < argv.length; index++) {
    const token = argv[index]!;
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const name = token.slice(2);
    requireCondition(
      optionsByCommand[commandName]!.includes(name) && !Object.hasOwn(options, name),
      `Unknown or repeated option ${token}.`,
    );
    if (name === 'json') {
      options[name] = true;
    } else {
      const value = argv[++index];
      requireCondition(value && !value.startsWith('--'), `Missing value for ${token}.`);
      options[name] = value;
    }
  }
  const needsTrace = ['replay', 'inspect', 'branch', 'minimize'].includes(commandName);
  requireCondition(
    positionals.length === (needsTrace ? 1 : 0),
    needsTrace ? 'Provide exactly one trace path.' : 'Unexpected positional argument.',
  );
  const number = (key: string, fallback: number, min: number, max: number) => {
    const value = options[key];
    requireCondition(
      value === undefined || (typeof value === 'string' && /^\d+$/.test(value)),
      `--${key} must be an integer.`,
    );
    const result = value === undefined ? fallback : Number(value);
    requireCondition(integer(result, min, max), `--${key} must be between ${min} and ${max}.`);
    return result;
  };
  const out = () => {
    requireCondition(typeof options.out === 'string' && options.out.length <= 4096, '--out is required.');
    return resolve(options.out);
  };
  return { commandName, options, positionals, number, out };
}

export async function main(argv: string[]): Promise<unknown> {
  const args = argumentsFor(argv);
  const identity = await provenance();
  const seed = () => args.number('seed', 17, 1, 0xffffffff - 1000);
  const steps = () => args.number('steps', 100, 1, 1000);
  let output: unknown;
  if (args.commandName === 'demo') {
    const directory = args.out();
    const data = await demo(identity);
    await mkdir(directory);
    for (const [name, trace] of Object.entries({
      original: data.original,
      branch: data.alternative,
      minimized: data.minimized,
      correct: data.correct,
      'lost-ack': data.lostAck,
      deadline: data.deadline,
      stale: data.stale,
    })) {
      await save(join(directory, `${name}.json`), trace);
    }
    await save(join(directory, 'summary.json'), data.summary);
    await copyFile(join(root, 'site/brand.css'), join(directory, 'brand.css'), constants.COPYFILE_EXCL);
    for (const name of ['Regular', 'Medium', 'SemiBold']) {
      await copyFile(
        join(root, `desktop/assets/fonts/Inter-${name}.ttf`),
        join(directory, `Inter-${name}.ttf`),
        constants.COPYFILE_EXCL,
      );
    }
    await writeFile(join(directory, 'index.html'), renderReport(data), { flag: 'wx' });
    output = { ...data.summary, directory, report: join(directory, 'index.html') };
  } else if (args.commandName === 'explore') {
    const faultModel = args.options['fault-model'] ?? 'correct';
    requireCondition(faultModel === 'correct' || faultModel === 'unsafe-claim-cas', 'Invalid --fault-model.');
    const fixture: Fixture = defaultFixture({
      faultModel,
      actors: ['a', 'b', 'c'].slice(0, args.number('actors', 3, 2, 3)),
      restarts: args.number('restarts', 1, 0, 2),
      maxFaults: args.number('faults', 3, 0, 10),
    });
    const campaign = await explore({
      provenance: identity,
      fixture,
      seed: seed(),
      runs: args.number('runs', 100, 1, 1000),
      steps: steps(),
    });
    const directory = args.out();
    await mkdir(directory);
    const name = campaign.failure ? 'failure.json' : 'last.json';
    await save(join(directory, name), campaign.failure ?? campaign.last);
    output = {
      runs: campaign.runs,
      counts: campaign.counts,
      bounds: campaign.bounds,
      artifact: join(directory, name),
      scope: 'Bounded search; no counterexample is not a proof.',
    };
    await save(join(directory, 'summary.json'), output);
  } else {
    const trace = await readTrace(resolve(args.positionals[0]!));
    let parent: Trace | undefined;
    if (trace.parent) {
      requireCondition(
        typeof args.options.parent === 'string',
        'Branched trace requires --parent to verify its prefix proof.',
      );
      parent = await readTrace(resolve(args.options.parent));
      verifyParent(trace, parent);
    } else {
      requireCondition(
        args.options.parent === undefined,
        '--parent supplied for a trace without a parent proof.',
      );
    }
    await replay(trace, identity, trace.events.length, parent);
    if (args.commandName === 'replay') {
      output = await replay(trace, identity, trace.events.length, parent);
    }
    if (args.commandName === 'inspect') {
      requireCondition(args.options.at !== undefined, '--at is required.');
      output = await replay(trace, identity, args.number('at', 0, 0, trace.events.length), parent);
    }
    if (args.commandName === 'branch') {
      requireCondition(args.options.at !== undefined, '--at is required.');
      let first: Choice | undefined;
      if (typeof args.options.choice === 'string') {
        let parsed: unknown;
        try {
          parsed = JSON.parse(args.options.choice);
        } catch {
          throw new Error('--choice is not valid JSON.');
        }
        first = parseChoice(parsed);
      }
      const child = await branch(trace, identity, {
        at: args.number('at', 0, 0, trace.events.length),
        seed: seed(),
        steps: steps(),
        ...(parent ? { parent } : {}),
        ...(first ? { first } : {}),
      });
      await save(args.out(), child);
      output = { artifact: args.out(), result: child.result, parent: child.parent };
    }
    if (args.commandName === 'minimize') {
      const reduced = await minimize(trace, identity, args.number('attempts', 300, 1, 2000), parent);
      await save(args.out(), reduced.trace);
      const { trace: minimized, ...summary } = reduced;
      output = { ...summary, artifact: args.out(), result: minimized.result };
    }
  }
  return output;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then((value) =>
      process.stdout.write(
        `${JSON.stringify(value, null, process.argv.includes('--json') ? undefined : 2)}\n`,
      ),
    )
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `${process.argv.includes('--json') ? JSON.stringify({ error: message }) : `Simulation error: ${message}`}\n`,
      );
      process.exitCode = 1;
    });
}
