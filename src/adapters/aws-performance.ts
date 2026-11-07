import { performanceCount } from '../core/performance.js';

interface Capacity { CapacityUnits?: number | undefined; ReadCapacityUnits?: number | undefined; WriteCapacityUnits?: number | undefined }
interface AwsMeasurement { $metadata?: { attempts?: number | undefined } | undefined; ConsumedCapacity?: Capacity | Capacity[] | undefined }

/** Capacity is reported by DynamoDB, including failed transactions when available. */
export async function measuredDynamo<T extends AwsMeasurement>(work: () => Promise<T>, kind: 'read' | 'write'): Promise<T> {
  try { const result = await work(); record(result, kind); return result; }
  catch (error) {
    performanceCount('DynamoErrors');
    record(error && typeof error === 'object' ? error as AwsMeasurement : {}, kind);
    throw error;
  }
}
function record(result: AwsMeasurement, kind: 'read' | 'write') {
  performanceCount('DynamoAttempts', result.$metadata?.attempts ?? 1);
  const capacities = Array.isArray(result.ConsumedCapacity) ? result.ConsumedCapacity : result.ConsumedCapacity ? [result.ConsumedCapacity] : [];
  performanceCount(capacities.length ? 'DynamoCapacityReports' : 'DynamoCapacityMissing');
  for (const capacity of capacities) {
    if (capacity.ReadCapacityUnits !== undefined || capacity.WriteCapacityUnits !== undefined) {
      performanceCount('DynamoReadCapacity', capacity.ReadCapacityUnits ?? 0);
      performanceCount('DynamoWriteCapacity', capacity.WriteCapacityUnits ?? 0);
    } else if (capacity.CapacityUnits !== undefined) {
      performanceCount(kind === 'read' ? 'DynamoReadCapacity' : 'DynamoUnclassifiedCapacity', capacity.CapacityUnits);
    }
  }
}
export async function measuredS3<T extends { $metadata?: { attempts?: number } }>(work: () => Promise<T>, kind: 'get' | 'put'): Promise<T> {
  performanceCount(kind === 'get' ? 'S3GetCount' : 'S3PutCount');
  try { const result = await work(); performanceCount('S3Attempts', result.$metadata?.attempts ?? 1); return result; }
  catch (error) {
    performanceCount('S3Errors');
    performanceCount('S3Attempts', (error as AwsMeasurement | undefined)?.$metadata?.attempts ?? 1);
    throw error;
  }
}
