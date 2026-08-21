import type { ArtifactReference, RunRecord } from './contracts.js';

export const ROUTINE_STATUSES = ['enabled', 'paused', 'deleted'] as const;
export type RoutineStatus = (typeof ROUTINE_STATUSES)[number];

export interface IntervalRoutineSchedule {
  kind: 'interval';
  everyMinutes: number;
}

export type RoutineSchedule = IntervalRoutineSchedule;

export interface RoutineRecord {
  version: '1';
  routineId: string;
  ownerId: string;
  ownerCreated: string;
  name: string;
  status: RoutineStatus;
  schedule: RoutineSchedule;
  nextRunAt: string;
  request: ArtifactReference;
  requestHash: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastRunId?: string;
  expiresAt?: number;
}

export interface ListRoutinesResult {
  items: RoutineRecord[];
  nextToken?: string;
}

export interface RoutineTickResult {
  examined: number;
  scheduled: number;
  runs: Array<Pick<RunRecord, 'runId' | 'status'>>;
}

export interface PublicRoutine extends Omit<RoutineRecord, 'ownerId' | 'ownerCreated' | 'request'> {}
