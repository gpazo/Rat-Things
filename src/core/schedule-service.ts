import { randomUUID } from 'node:crypto';
import { AgentsApiError, resourceNotFound } from '../domain/agents-api-validation.js';
import { scheduleConfiguration, scheduleInput, scheduleInvocation, type Schedule, type ScheduleState, type ScheduleInvocation, type ScheduleConfiguration } from '../domain/schedules.js';
import type { AgentsStore, AgentsClock } from './agents-ports.js';
import type { SessionService } from './session-service.js';
import type { SessionIntegrationService } from './session-integration-service.js';
import { integrationSessionId } from './session-integration-planning.js';

export interface SessionScheduler {
  upsert(ownerId: string, schedule: Schedule): Promise<void>;
  remove(id: string): Promise<void>;
}

export class ScheduleService {
  public constructor(private readonly options: { store: AgentsStore; scheduler: SessionScheduler; integrations: SessionIntegrationService; sessions: Pick<SessionService, 'retrieve'>; validateTarget(ownerId: string, target: ScheduleConfiguration): Promise<void>; clock?: AgentsClock }) {}
  public async create(ownerId: string, raw: unknown): Promise<Schedule> {
    const config = scheduleConfiguration(raw);
    await this.options.validateTarget(ownerId, config);
    const now = this.now();
    const schedule: Schedule = { ...config, id: `sched_${randomUUID().replaceAll('-', '')}`, object: 'rat.schedule', created_at: now, updated_at: now, generation: 1, status: 'active' };
    // The table stream synchronizes Scheduler; a crash cannot strand an accepted definition.
    await this.options.store.put<ScheduleState>({ ownerId, id: schedule.id, collection: 'schedules', createdAt: now, revision: 1, value: { schedule, occurrences: {} } }, 0);
    return schedule;
  }
  public async retrieve(ownerId: string, id: string) { return (await this.required(ownerId, id)).value.schedule; }
  public async list(ownerId: string, query: { after?: string; limit?: number } = {}) {
    const page = await this.options.store.list<ScheduleState>(ownerId, 'schedules', query);
    return { object: 'list' as const, data: page.data.map(({ value }) => value.schedule), has_more: page.has_more };
  }
  public async update(ownerId: string, id: string, raw: unknown) {
    const config = scheduleConfiguration(raw);
    await this.options.validateTarget(ownerId, config);
    const current = await this.required(ownerId, id);
    if (current.value.schedule.status === 'deleted') resourceNotFound();
    const schedule = { ...current.value.schedule, ...config, generation: current.value.schedule.generation + 1, updated_at: this.now() };
    await this.options.store.put({ ...current, revision: current.revision + 1, value: { ...current.value, schedule } }, current.revision);
    return schedule;
  }
  public async status(ownerId: string, id: string, status: Schedule['status']) {
    const current = await this.required(ownerId, id);
    if (current.value.schedule.status === 'deleted') resourceNotFound();
    const schedule = { ...current.value.schedule, status, generation: current.value.schedule.generation + 1, updated_at: this.now() };
    await this.options.store.put({ ...current, revision: current.revision + 1, value: { ...current.value, schedule } }, current.revision);
    return schedule;
  }
  public async synchronize(ownerId: string, id: string) {
    const current = await this.options.store.get<ScheduleState>(ownerId, 'schedules', id);
    if (!current || current.value.schedule.status === 'deleted') await this.options.scheduler.remove(id);
    else await this.options.scheduler.upsert(ownerId, current.value.schedule);
  }
  public async invoke(raw: unknown): Promise<{ accepted: true; sessionId: string } | { accepted: false; reason: string }> {
    const invocation = scheduleInvocation(raw);
    const { ownerId, scheduleId, scheduledAt } = invocation;
    for (let attempt = 0; ; attempt++) {
      const current = await this.options.store.get<ScheduleState>(ownerId, 'schedules', scheduleId);
      if (!current) return { accepted: false, reason: 'schedule_missing' };
      const previous = current.value.occurrences[scheduledAt];
      // An accepted occurrence retains its snapshot even if its schedule is subsequently edited.
      if (previous) return 'skipped' in previous ? { accepted: false, reason: 'overlap' } : this.submit(invocation, previous.configuration, previous.sessionId);
      const { schedule } = current.value;
      if (schedule.status !== 'active' || invocation.generation !== schedule.generation) return { accepted: false, reason: 'stale_schedule' };
      const overlapping = schedule.overlap === 'skip' && current.value.activeSessionId && await this.active(ownerId, current.value.activeSessionId);
      const sessionId = integrationSessionId(scheduleId, scheduledAt);
      const occurrence = overlapping ? { skipped: true as const } : { sessionId, configuration: scheduleConfiguration(configurationFields(schedule)) };
      try {
        await this.options.store.put({ ...current, revision: current.revision + 1, value: { ...current.value, ...(overlapping ? {} : { activeSessionId: sessionId }), occurrences: { ...current.value.occurrences, [scheduledAt]: occurrence } } }, current.revision);
      } catch (error) { if (!(error instanceof AgentsApiError) || error.code !== 'conflict' || attempt >= 9) throw error; continue; }
      return 'skipped' in occurrence ? { accepted: false, reason: 'overlap' } : this.submit(invocation, occurrence.configuration, sessionId);
    }
  }
  private async submit(invocation: ScheduleInvocation, configuration: ScheduleConfiguration, sessionId: string) {
    await this.options.integrations.accept(invocation.ownerId, invocation.scheduleId, invocation.scheduledAt, configuration, {
      id: invocation.scheduledAt, text: scheduleInput(configuration, invocation), source: { kind: 'api' },
      actor: { kind: 'system', id: `schedule:${invocation.scheduleId}`, provider: 'api' }, credentialSubject: { kind: 'actor', id: invocation.ownerId },
    });
    return { accepted: true as const, sessionId };
  }
  private async active(ownerId: string, id: string): Promise<boolean> {
    try { return (await this.options.sessions.retrieve(ownerId, id)).status === 'in_progress'; }
    catch (error) {
      if (!(error instanceof AgentsApiError) || error.status !== 404) throw error;
      // Reserved occurrences and deleted Sessions are distinguished by the accepted integration.
      const integration = await this.options.store.get<{ inputs: Array<{ turnId?: string }> }>(ownerId, 'session_integrations', id);
      return !integration || integration.value.inputs.some((input) => !input.turnId);
    }
  }
  private async required(ownerId: string, id: string) { return await this.options.store.get<ScheduleState>(ownerId, 'schedules', id) ?? resourceNotFound(); }
  private now() { return this.options.clock?.now() ?? Math.floor(Date.now() / 1000); }
}
function configurationFields({ id: _id, object: _object, created_at: _created, updated_at: _updated, generation: _generation, status: _status, ...configuration }: Schedule): ScheduleConfiguration { return configuration; }
