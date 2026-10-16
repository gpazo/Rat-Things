import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, defaultFixture, type Choice, type Fixture, type Provenance, type Trace } from './model.js';
import { branch, explore, minimize, replay, Simulator, verifyParent } from './simulator.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const maxBytes = 32 * 1024 * 1024;
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  requireCondition(required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => [...required, ...optional].includes(key)), 'Unexpected or missing artifact fields.');
}
function integer(value: unknown, min: number, max: number): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max; }
function digest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function validateChoice(value: unknown): void {
  requireCondition(record(value), 'Invalid choice.');
  switch (value.kind) {
    case 'start': case 'crash': case 'resume': keys(value, ['kind', 'actor']); requireCondition(typeof value.actor === 'string' && /^(?:[abc]|restart-[12])$/.test(value.actor), 'Invalid actor.'); break;
    case 'apply': keys(value, ['kind', 'op', 'result']); requireCondition(typeof value.result === 'string' && ['normal', 'fail-before'].includes(value.result), 'Invalid apply result.'); break;
    case 'ack': keys(value, ['kind', 'op', 'delivery']); requireCondition(typeof value.delivery === 'string' && ['normal', 'error', 'lost'].includes(value.delivery), 'Invalid acknowledgement.'); break;
    case 'advance': keys(value, ['kind', 'to']); requireCondition(integer(value.to, 1, 1000), 'Invalid virtual time.'); break;
    default: throw new Error('Invalid choice kind.');
  }
  if ('op' in value) requireCondition(typeof value.op === 'string' && /^(?:[abc]|restart-[12]):[1-9]\d{0,3}$/.test(value.op), 'Invalid operation id.');
}
export function parseTrace(value: unknown): Trace {
  requireCondition(record(value), 'Expected a trace object.'); keys(value, ['format', 'fixture', 'provenance', 'seed', 'stepLimit', 'events', 'result'], ['parent']);
  requireCondition(value.format === 1 && integer(value.seed, 1, 0xffffffff) && integer(value.stepLimit, 1, 2000), 'Invalid format, seed, or step limit.');
  const fixture = value.fixture;
  requireCondition(record(fixture), 'Invalid fixture.'); keys(fixture, ['actors', 'restarts', 'deadline', 'staleTarget', 'faultModel', 'maxFaults', 'maxTime']);
  requireCondition(Array.isArray(fixture.actors) && fixture.actors.length >= 1 && fixture.actors.length <= 3 && fixture.actors.every((id) => ['a', 'b', 'c'].includes(id)) && new Set(fixture.actors).size === fixture.actors.length, 'Invalid actor workload.');
  requireCondition(integer(fixture.restarts, 0, 2) && integer(fixture.deadline, 1, 500) && integer(fixture.maxTime, fixture.deadline, 1000) && integer(fixture.maxFaults, 0, 10) && typeof fixture.staleTarget === 'boolean' && typeof fixture.faultModel === 'string' && ['correct', 'unsafe-claim-cas'].includes(fixture.faultModel), 'Invalid fixture bounds.');
  const provenance = value.provenance;
  requireCondition(record(provenance), 'Invalid provenance.'); keys(provenance, ['sources', 'runtime', 'git']);
  requireCondition(record(provenance.sources) && Object.keys(provenance.sources).length <= 5000 && Object.entries(provenance.sources).every(([path, identity]) => path.length < 500 && digest(identity)) && typeof provenance.git === 'string' && provenance.git.length < 1000, 'Invalid source identities.');
  requireCondition(record(provenance.runtime), 'Invalid runtime.'); keys(provenance.runtime, ['node', 'tsx', 'platform', 'arch']);
  requireCondition(Object.values(provenance.runtime).every((item) => typeof item === 'string' && item.length < 100), 'Invalid runtime identity.');
  requireCondition(Array.isArray(value.events) && value.events.length <= value.stepLimit, 'Invalid event bounds.');
  for (const event of value.events) {
    requireCondition(record(event), 'Invalid event.'); keys(event, ['index', 'choice', 'observations', 'world', 'worldHash', 'previousHash', 'hash']);
    requireCondition(integer(event.index, 1, 2000) && Array.isArray(event.observations) && event.observations.length <= 20 && record(event.world) && digest(event.worldHash) && digest(event.previousHash) && digest(event.hash), 'Invalid event shape.');
    validateChoice(event.choice);
  }
  requireCondition(record(value.result), 'Invalid result.'); keys(value.result, ['status', 'violations', 'steps', 'effects']);
  requireCondition(typeof value.result.status === 'string' && ['violation', 'completed', 'parked', 'budget-exhausted'].includes(value.result.status) && Array.isArray(value.result.violations) && value.result.violations.length <= 5 && integer(value.result.steps, 0, 2000) && integer(value.result.effects, 0, 5), 'Invalid result bounds.');
  for (const violation of value.result.violations) requireCondition(record(violation) && Object.keys(violation).length === 2 && violation.command === 'command' && typeof violation.property === 'string' && ['at-most-once', 'claim-before-effect', 'deadline-at-invocation', 'stale-target', 'atomic-response'].includes(violation.property), 'Invalid violation.');
  if (value.parent !== undefined) {
    requireCondition(record(value.parent), 'Invalid parent proof.'); keys(value.parent, ['digest', 'at', 'prefixHash']);
    requireCondition(digest(value.parent.digest) && digest(value.parent.prefixHash) && integer(value.parent.at, 0, value.events.length), 'Invalid parent proof.');
  }
  return value as Trace;
}
export async function provenance(): Promise<Provenance> {
  async function files(path: string): Promise<string[]> {
    const entries = await readdir(join(root, path), { withFileTypes: true });
    return (await Promise.all(entries.map(async (entry) => entry.isDirectory() ? files(`${path}/${entry.name}`) : [`${path}/${entry.name}`]))).flat();
  }
  const paths = [...await files('src'), ...await files('testing/time-travel'), 'tests/agents/fixtures.ts', 'package-lock.json', 'package.json', 'tsconfig.json', 'spec/schemas/agents-api.schema.json'].sort();
  const sources = Object.fromEntries(await Promise.all(paths.map(async (path) => [path, createHash('sha256').update(await readFile(join(root, path))).digest('hex')])));
  let git = 'unavailable';
  try { git = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
  const tsx = JSON.parse(await readFile(join(root, 'node_modules/tsx/package.json'), 'utf8')) as { version: string };
  return { sources, runtime: { node: process.version, tsx: tsx.version, platform: process.platform, arch: process.arch }, git };
}
export async function readTrace(path: string): Promise<Trace> {
  requireCondition((await stat(path)).size <= maxBytes, 'Trace exceeds 32 MiB.');
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('Trace is not valid JSON.'); }
  return parseTrace(parsed);
}
async function save(path: string, value: unknown): Promise<void> {
  const bytes = `${JSON.stringify(value, null, 2)}\n`; requireCondition(Buffer.byteLength(bytes) <= maxBytes, 'Artifact exceeds 32 MiB.');
  await writeFile(path, bytes, { flag: 'wx' });
}
const optionsByCommand: Record<string, string[]> = {
  explore: ['seed', 'runs', 'steps', 'out', 'fault-model', 'actors', 'restarts', 'faults', 'json'],
  replay: ['json', 'parent'], inspect: ['at', 'json', 'parent'],
  branch: ['at', 'seed', 'steps', 'out', 'json', 'parent', 'choice'], minimize: ['attempts', 'out', 'json', 'parent'], demo: ['out', 'json'],
};
function argumentsFor(argv: string[]) {
  const commandName = argv[0]; requireCondition(commandName && optionsByCommand[commandName], 'Usage: sim:commands <explore|replay|inspect|branch|minimize|demo> [options]');
  const options: Record<string, string | true> = {}; const positionals: string[] = [];
  for (let index = 1; index < argv.length; index++) {
    const token = argv[index]!;
    if (!token.startsWith('--')) { positionals.push(token); continue; }
    const name = token.slice(2); requireCondition(optionsByCommand[commandName]!.includes(name) && !Object.hasOwn(options, name), `Unknown or repeated option ${token}.`);
    if (name === 'json') options[name] = true;
    else { const value = argv[++index]; requireCondition(value && !value.startsWith('--'), `Missing value for ${token}.`); options[name] = value; }
  }
  const needsTrace = ['replay', 'inspect', 'branch', 'minimize'].includes(commandName);
  requireCondition(positionals.length === (needsTrace ? 1 : 0), needsTrace ? 'Provide exactly one trace path.' : 'Unexpected positional argument.');
  const number = (key: string, fallback: number, min: number, max: number) => {
    const value = options[key]; requireCondition(value === undefined || (typeof value === 'string' && /^\d+$/.test(value)), `--${key} must be an integer.`);
    const result = value === undefined ? fallback : Number(value); requireCondition(integer(result, min, max), `--${key} must be between ${min} and ${max}.`); return result;
  };
  const out = () => { requireCondition(typeof options.out === 'string' && options.out.length <= 4096, '--out is required.'); return resolve(options.out); };
  return { commandName, options, positionals, number, out };
}
async function settlePort(runner: Simulator, actor: string, ordinal: number) {
  await runner.step({ kind: 'apply', op: `${actor}:${ordinal}`, result: 'normal' });
  await runner.step({ kind: 'ack', op: `${actor}:${ordinal}`, delivery: 'normal' });
  await runner.step({ kind: 'resume', actor });
}
async function finishNormally(runner: Simulator, seed = 2) { return runner.run(seed, 150, true); }
export async function demo(identity: Provenance) {
  const fixture = defaultFixture({ faultModel: 'unsafe-claim-cas', restarts: 0 });
  const prefix: Choice[] = [{ kind: 'start', actor: 'c' }, { kind: 'apply', op: 'c:1', result: 'normal' }, { kind: 'ack', op: 'c:1', delivery: 'normal' }, { kind: 'resume', actor: 'c' }, { kind: 'crash', actor: 'c' }];
  const campaign = await explore({ provenance: identity, fixture, seed: 17, runs: 100, steps: 80, prefix, safe: true });
  const original = campaign.failure; requireCondition(original !== undefined && original.result.violations.some((v) => v.property === 'at-most-once'), 'Demo search did not find the injected duplicate-effect witness.');
  const verified = await replay(original, identity);
  requireCondition(verified.world.effects.length === 2, 'Witness replay failed.');
  const firstPerform = original.events.findIndex((event) => event.observations.some((observation) => record(observation) && observation.kind === 'invoked' && record(observation.gate) && record(observation.gate.operation) && observation.gate.operation.kind === 'perform'));
  const at = firstPerform + 1;
  requireCondition(at > 0, 'No branch boundary found.');
  const selected = await replay(original, identity, at);
  const victim = selected.world.gates.find((gate) => gate.operation.kind === 'perform')!.actor;
  const alternative = await branch(original, identity, { at, seed: 91, steps: 80, first: { kind: 'crash', actor: victim } });
  requireCondition(alternative.result.effects === 1 && alternative.result.violations.length === 0 && canonical(alternative.events.slice(0, at)) === canonical(original.events.slice(0, at)), 'Branch did not preserve the prefix and prevent the second effect.');
  await replay(alternative, identity, alternative.events.length, original);
  const reduced = await minimize(original, identity, 300);
  requireCondition(reduced.trace.fixture.actors.length < original.fixture.actors.length && reduced.trace.events.length < original.events.length && reduced.trace.result.violations.some((v) => v.property === 'at-most-once'), 'Minimization did not remove irrelevant actor workload.');
  const correctRunner = await Simulator.create({ ...fixture, faultModel: 'correct' }, identity);
  let skipped = 0;
  for (const event of original.events) {
    try { await correctRunner.step(event.choice); } catch (error) { if (error instanceof Error && error.message.startsWith('Illegal choice')) skipped++; else throw error; }
  }
  const correct = await finishNormally(correctRunner);
  requireCondition(correct.result.effects === 1 && correct.result.violations.length === 0, 'Correct fence rerun failed.');
  const fresh = await explore({ provenance: identity, fixture: defaultFixture(), seed: 901, runs: 100, steps: 100 });
  requireCondition(!fresh.failure, 'Correct-store bounded exploration found a violation.');
  const lostRunner = await Simulator.create(defaultFixture({ actors: ['a', 'b'], restarts: 1 }), identity);
  await lostRunner.step({ kind: 'start', actor: 'a' }); await settlePort(lostRunner, 'a', 1);
  await lostRunner.step({ kind: 'apply', op: 'a:2', result: 'normal' }); await lostRunner.step({ kind: 'ack', op: 'a:2', delivery: 'lost' });
  await lostRunner.step({ kind: 'crash', actor: 'a' });
  const lostAck = await finishNormally(lostRunner);
  requireCondition(lostAck.result.effects === 0 && (lostRunner.snapshot().resources[0]?.value as { status?: string }).status === 'claimed' && lostRunner.snapshot().actors.find((actor) => actor.id === 'a')?.calls === 2, 'Lost acknowledgement/crash did not retain the durable claim.');
  const deadlineRunner = await Simulator.create(defaultFixture({ actors: ['a'], restarts: 0 }), identity);
  await deadlineRunner.step({ kind: 'start', actor: 'a' }); await settlePort(deadlineRunner, 'a', 1);
  await deadlineRunner.step({ kind: 'apply', op: 'a:2', result: 'normal' }); await deadlineRunner.step({ kind: 'advance', to: 20 });
  await deadlineRunner.step({ kind: 'ack', op: 'a:2', delivery: 'normal' }); await deadlineRunner.step({ kind: 'resume', actor: 'a' });
  const deadline = await finishNormally(deadlineRunner);
  requireCondition(deadline.result.effects === 0 && deadline.result.violations.length === 0, 'Deadline crossing executed an effect.');
  const staleRunner = await Simulator.create(defaultFixture({ actors: ['a'], restarts: 0, staleTarget: true }), identity);
  const stale = await finishNormally(staleRunner);
  requireCondition(stale.result.effects === 0 && stale.result.violations.length === 0, 'Stale target executed an effect.');
  const tampered = structuredClone(original); tampered.events[0]!.world.now = 999;
  let tamperRejected = false; try { await replay(tampered, identity); } catch { tamperRejected = true; }
  requireCondition(tamperRejected, 'Tampered trace was accepted.');
  return { original, alternative, minimized: reduced.trace, correct, lostAck, deadline, stale,
    summary: { injectedDefect: 'unsafe-claim-cas, a test-only broken store; not a production bug', search: { seed: 17, runs: campaign.runs, bounds: campaign.bounds, setup: 'irrelevant consumer c reads then crashes; the race suffix is seeded exploration' }, replayVerified: true, branch: { at, effects: alternative.result.effects, prefixHash: alternative.parent!.prefixHash }, minimization: { tested: reduced.tested, transformations: reduced.transformations, originalSteps: reduced.originalSteps, minimizedSteps: reduced.minimizedSteps, stopped: reduced.stopped }, correct: { effects: correct.result.effects, incompatibleOriginalChoicesSkipped: skipped, freshSearch: { runs: fresh.runs, counts: fresh.counts, bounds: fresh.bounds } }, checks: { lostAckAndCrash: true, deadline: true, staleTarget: true, tamperRejected }, scope: 'One synthetic command, bounded actors and crashes, atomic in-memory storage. No AWS, real external effects, model calls, or exhaustive proof.' } };
}

async function report(directory: string, data: Awaited<ReturnType<typeof demo>>) {
  await copyFile(join(root, 'site/brand.css'), join(directory, 'brand.css'), constants.COPYFILE_EXCL);
  for (const name of ['Regular', 'Medium', 'SemiBold']) await copyFile(join(root, `desktop/assets/fonts/Inter-${name}.ttf`), join(directory, `Inter-${name}.ttf`), constants.COPYFILE_EXCL);
  const payload = JSON.stringify({ traces: { Original: data.original, Branch: data.alternative, Correct: data.correct }, summary: data.summary }).replaceAll('<', '\\u003c');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Command time travel · Rat Things</title><link rel="stylesheet" href="brand.css"><style>
@font-face{font-family:Inter;src:url('Inter-Regular.ttf');font-weight:400}@font-face{font-family:Inter;src:url('Inter-Medium.ttf');font-weight:500}@font-face{font-family:Inter;src:url('Inter-SemiBold.ttf');font-weight:600}
*{box-sizing:border-box}body{margin:0;background:var(--rt-bg);color:var(--rt-text);font:16px/1.6 var(--rt-font)}main{max-width:1240px;margin:auto;padding:40px 24px}h1,h2,h3{font-weight:600;line-height:1.15;letter-spacing:-.02em}h1{font-size:42px;margin:8px 0 16px}h2{font-size:22px}p{color:var(--rt-text-secondary)}.kicker,.muted{color:var(--rt-muted)}.kicker{font-size:14px;font-weight:500}.notice{border:1px solid var(--rt-border-strong);border-radius:var(--rt-radius);padding:16px;background:var(--rt-panel)}.compare{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:28px 0}.card{background:var(--rt-card);border:1px solid var(--rt-border);border-radius:var(--rt-radius);padding:20px}.card strong{font-weight:600;font-size:32px;display:block}.card p{margin:0;font-size:14px}.card h2{margin:0 0 12px}.selected{border-color:var(--rt-accent)}button,select{font:500 14px var(--rt-font);min-height:40px;border:1px solid var(--rt-border-strong);border-radius:var(--rt-radius);padding:8px 12px;background:var(--rt-card);color:var(--rt-text);cursor:pointer}button:hover{background:var(--rt-hover)}button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid var(--rt-accent);outline-offset:3px}.primary{background:var(--rt-primary-fill);color:var(--rt-primary-text)}.toolbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap}input{accent-color:var(--rt-accent);width:100%;margin:24px 0}.layout{display:grid;grid-template-columns:1fr 1fr;gap:16px}.panel{background:var(--rt-panel);border:1px solid var(--rt-border);border-radius:var(--rt-radius);padding:20px;min-width:0}pre{font:13px/1.55 var(--rt-mono);overflow:auto;max-height:380px;white-space:pre-wrap;overflow-wrap:anywhere}#events{max-height:420px;overflow:auto;display:flex;flex-direction:column;gap:6px}#events button{text-align:left;font-weight:400;font-family:var(--rt-mono);font-size:12px}#events button[aria-current=true]{background:var(--rt-selected);border-color:var(--rt-accent)}.metrics{display:flex;gap:24px;margin:16px 0;color:var(--rt-text-secondary)}a{color:var(--rt-accent)}footer{color:var(--rt-muted);font-size:13px;margin-top:32px}@media(max-width:750px){main{padding:24px 16px}h1{font-size:32px}.compare,.layout{grid-template-columns:1fr}.metrics{flex-wrap:wrap}}
</style></head><body><main><div class="kicker">Rat Things · Command time travel</div><h1>See where one effect becomes two.</h1><p>Replay a recorded schedule through the real command service. Select an event to inspect the durable records and external effect ledger at that boundary.</p><div class="notice">The original uses <strong>unsafe-claim-cas</strong>, an intentionally broken test store. This witness demonstrates the simulator. It is not a production bug.</div><div class="compare" id="comparison"></div><div class="toolbar"><label for="trace">Trace</label><select id="trace"><option>Original</option><option>Branch</option><option>Correct</option></select><button id="previous">Previous event</button><button id="next" class="primary">Next event</button><span id="position" class="muted"></span></div><input id="timeline" type="range" min="1" aria-label="Event timeline"><div class="metrics"><span id="effect-count"></span><span id="clock"></span><span id="durable"></span></div><div class="layout"><section class="panel"><h2>Recorded schedule</h2><div id="events"></div></section><section class="panel"><h2 id="detail-title">Event details</h2><pre id="details"></pre><h2>Durable state</h2><pre id="state"></pre><h2>External effect ledger</h2><pre id="effects"></pre></section></div><section class="panel" style="margin-top:16px"><h2>Verified demonstration</h2><p id="proof"></p><a href="summary.json">Read the machine report</a> · <a id="trace-link" href="original.json">Download selected trace</a></section><footer>One synthetic command. Atomic in-memory storage. Bounded schedules, actors and crashes. No AWS or model calls. No exhaustive guarantee. The controls inspect saved execution data.</footer></main><script type="application/json" id="data">${payload}</script><script>
const data=JSON.parse(document.getElementById('data').textContent), selector=document.getElementById('trace'), slider=document.getElementById('timeline');let position=1;
const text=(id,value)=>document.getElementById(id).textContent=value;
function render(){const trace=data.traces[selector.value];position=Math.min(Math.max(1,position),trace.events.length);slider.max=trace.events.length;slider.value=position;const event=trace.events[position-1];text('position','Event '+position+' of '+trace.events.length);text('effect-count','Effects applied: '+event.world.effects.length);text('clock','Virtual time: '+event.world.now);text('durable','Durable records: '+event.world.resources.length);text('detail-title','Event '+position+' · '+event.choice.kind);text('details',JSON.stringify({choice:event.choice,observations:event.observations,worldHash:event.worldHash},null,2));text('state',JSON.stringify(event.world.resources,null,2));text('effects',JSON.stringify(event.world.effects,null,2));document.getElementById('events').replaceChildren(...trace.events.map(e=>{const b=document.createElement('button');b.textContent=e.index+'. '+JSON.stringify(e.choice);b.setAttribute('aria-current',String(e.index===position));b.onclick=()=>{position=e.index;render()};return b}));document.getElementById('trace-link').href=selector.value.toLowerCase()+'.json';document.getElementById('comparison').replaceChildren(...Object.entries(data.traces).map(([name,t])=>{const card=document.createElement('section');card.className='card'+(name===selector.value?' selected':'');const h=document.createElement('h2');h.textContent=name;const n=document.createElement('strong');n.textContent=t.result.effects+' effect'+(t.result.effects===1?'':'s');const p=document.createElement('p');p.textContent=name==='Original'?'Injected broken claim fence':name==='Branch'?'Same prefix, crash before effect':'Real compare-and-swap fence';card.append(h,n,p);return card}));}
selector.onchange=()=>{position=data.traces[selector.value].events.length;render()};slider.oninput=()=>{position=Number(slider.value);render()};document.getElementById('previous').onclick=()=>{position--;render()};document.getElementById('next').onclick=()=>{position++;render()};const s=data.summary;text('proof','Seed '+s.search.seed+' found the witness after '+s.search.runs+' run(s). Replay verified. The branch preserves events 1–'+s.branch.at+'. Minimization reduced '+s.minimization.originalSteps+' events to '+s.minimization.minimizedSteps+' by rerunning candidates, including actor removal. For the correct fence, '+s.correct.freshSearch.runs+' bounded runs found no invariant violation. Lost acknowledgement, crash, deadline, stale target and tamper checks passed.');position=data.traces.Original.events.length;render();
</script></body></html>`;
  await writeFile(join(directory, 'index.html'), html, { flag: 'wx' });
}
export async function main(argv: string[]): Promise<unknown> {
  const args = argumentsFor(argv); const identity = await provenance();
  const seed = () => args.number('seed', 17, 1, 0xffffffff - 1000);
  const steps = () => args.number('steps', 100, 1, 1000);
  let output: unknown;
  if (args.commandName === 'demo') {
    const directory = args.out(); const data = await demo(identity); await mkdir(directory);
    for (const [name, trace] of Object.entries({ original: data.original, branch: data.alternative, minimized: data.minimized, correct: data.correct, 'lost-ack': data.lostAck, deadline: data.deadline, stale: data.stale })) await save(join(directory, `${name}.json`), trace);
    await save(join(directory, 'summary.json'), data.summary); await report(directory, data);
    output = { ...data.summary, directory, report: join(directory, 'index.html') };
  } else if (args.commandName === 'explore') {
    const faultModel = args.options['fault-model'] ?? 'correct'; requireCondition(faultModel === 'correct' || faultModel === 'unsafe-claim-cas', 'Invalid --fault-model.');
    const fixture: Fixture = defaultFixture({ faultModel, actors: ['a', 'b', 'c'].slice(0, args.number('actors', 3, 2, 3)), restarts: args.number('restarts', 1, 0, 2), maxFaults: args.number('faults', 3, 0, 10) });
    const campaign = await explore({ provenance: identity, fixture, seed: seed(), runs: args.number('runs', 100, 1, 1000), steps: steps() });
    const directory = args.out(); await mkdir(directory); const name = campaign.failure ? 'failure.json' : 'last.json'; await save(join(directory, name), campaign.failure ?? campaign.last);
    output = { runs: campaign.runs, counts: campaign.counts, bounds: campaign.bounds, artifact: join(directory, name), scope: 'Bounded search; no counterexample is not a proof.' }; await save(join(directory, 'summary.json'), output);
  } else {
    const trace = await readTrace(resolve(args.positionals[0]!));
    let parent: Trace | undefined;
    if (trace.parent) { requireCondition(typeof args.options.parent === 'string', 'Branched trace requires --parent to verify its prefix proof.'); parent = await readTrace(resolve(args.options.parent)); verifyParent(trace, parent); }
    else requireCondition(args.options.parent === undefined, '--parent supplied for a trace without a parent proof.');
    await replay(trace, identity, trace.events.length, parent);
    if (args.commandName === 'replay') output = await replay(trace, identity, trace.events.length, parent);
    if (args.commandName === 'inspect') { requireCondition(args.options.at !== undefined, '--at is required.'); output = await replay(trace, identity, args.number('at', 0, 0, trace.events.length), parent); }
    if (args.commandName === 'branch') {
      requireCondition(args.options.at !== undefined, '--at is required.');
      let first: Choice | undefined;
      if (typeof args.options.choice === 'string') { let parsed: unknown; try { parsed = JSON.parse(args.options.choice); } catch { throw new Error('--choice is not valid JSON.'); } validateChoice(parsed); first = parsed as Choice; }
      const child = await branch(trace, identity, { at: args.number('at', 0, 0, trace.events.length), seed: seed(), steps: steps(), ...(parent ? { parent } : {}), ...(first ? { first } : {}) });
      await save(args.out(), child); output = { artifact: args.out(), result: child.result, parent: child.parent };
    }
    if (args.commandName === 'minimize') { const reduced = await minimize(trace, identity, args.number('attempts', 300, 1, 2000), parent); await save(args.out(), reduced.trace); const { trace: minimized, ...summary } = reduced; output = { ...summary, artifact: args.out(), result: minimized.result }; }
  }
  return output;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((value) => process.stdout.write(`${JSON.stringify(value, null, process.argv.includes('--json') ? undefined : 2)}\n`)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${process.argv.includes('--json') ? JSON.stringify({ error: message }) : `Simulation error: ${message}`}\n`); process.exitCode = 1;
  });
}
