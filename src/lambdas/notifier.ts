import type { EventBridgeEvent, EventBridgeHandler } from 'aws-lambda';
import { getDeliveryService } from '../app/composition.js';
import type { RunStateEvent } from '../domain/contracts.js';

export const handler: EventBridgeHandler<'Agent Run State', RunStateEvent, void> = async (
  event: EventBridgeEvent<'Agent Run State', RunStateEvent>,
) => getDeliveryService().handle(event.detail);
