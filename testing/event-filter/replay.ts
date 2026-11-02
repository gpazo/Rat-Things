import { readFile } from 'node:fs/promises';
import { classifyEvent } from '../../src/core/event-filter-planning.js';
import { BedrockEventFilter } from '../../src/adapters/bedrock-event-filter.js';
import type { SourceEventPolicy } from '../../src/domain/event-policy.js';

interface Fixture { text: string; mentioned: boolean; bot?: boolean; selfLoop?: boolean; act: boolean }
const fixtures: Fixture[] = JSON.parse(await readFile(new URL('./noise.json', import.meta.url), 'utf8'));
const policy: SourceEventPolicy = { mode: 'candidate', semantic: { policies: ['Act on unresolved release failures that nobody is investigating.'], maxCandidatesPerHour: 20 } };
const modelId = process.env.EVENT_FILTER_REPLAY_MODEL_ID;
const model = modelId ? new BedrockEventFilter({ model: modelId, region: process.env.AWS_REGION ?? 'us-east-1' }) : undefined;
const rows = [];
for (const fixture of fixtures) {
  const classification = classifyEvent({ ...fixture, actorId: 'slack:fixture:user', channelId: 'fixture-channel' }, policy, false);
  const decision = classification === 'candidate' ? model ? await model.decide({ policies: policy.semantic!.policies, eventText: fixture.text, threadText: '' }) : { act: fixture.act, reason: 'fixture annotation' } : undefined;
  rows.push({ classification, act: decision?.act ?? false, expectedAct: fixture.act });
}
const candidates = rows.filter(row => row.classification === 'candidate');
const acts = candidates.filter(row => row.act);
console.log(JSON.stringify({ mode: model ? 'model-replay' : 'annotated-fixture', model: model?.id ?? null, events: rows.length, explicit: rows.filter(row => row.classification === 'accept').length, dropped: rows.filter(row => row.classification === 'drop').length,
  candidates: candidates.length, acts: acts.length, candidateRate: candidates.length / rows.length, actRateAmongCandidates: acts.length / candidates.length,
  disagreements: candidates.filter(row => row.act !== row.expectedAct).length }, null, 2));
