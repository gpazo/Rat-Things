// @ts-check

/** @typedef {import('../src/core/agent-activity-projection.js').PublicAgentActivity} Activity */
/** @typedef {Activity & {count?: number}} CountedActivity */
/** @typedef {{key: string, icon: string, title: string, detail: string}} Phase */
/** @typedef {Phase & {count: number, occurredAt: string, status: Activity['status'], sourceDetail: string | undefined}} ActivityGroup */

/** Keep event order and distinct details; only adjacent identical updates collapse.
 * @param {readonly CountedActivity[]} events @returns {CountedActivity[]}
 */
export function coalesceActivities(events) {
  /** @type {CountedActivity[]} */
  const result = [];
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    const previous = result.at(-1);
    if (previous && event.status === 'updated' && previous.status === event.status
      && previous.kind === event.kind && previous.title === event.title && previous.detail === event.detail) {
      Object.assign(previous, event, {count: (previous.count ?? 1) + (event.count ?? 1)});
    } else result.push({...event});
  }
  return result;
}

/** @param {Activity} activity */
function isBackgroundActivity(activity) {
  return activity.status !== 'failed' && ((!activity.detail && ['message', 'reasoning'].includes(activity.kind))
    || activity.kind === 'usage'
    || (activity.kind === 'activity' && activity.title === 'Agent activity'));
}

/** @param {ActivityGroup | undefined} previous @param {Activity} activity @param {Phase} phase */
function continuesPhase(previous, activity, phase) {
  return previous?.key === phase.key && previous.status !== 'failed' && activity.status !== 'failed'
    && activity.kind !== 'error'
    && !(activity.kind === 'commentary' && previous.detail !== phase.detail)
    && !(previous.status === 'completed' && activity.status === 'started')
    && !(previous.sourceDetail && previous.sourceDetail !== activity.detail);
}

/** Shared phase grouping for the console timeline and readable CLI progress.
 * @param {readonly CountedActivity[]} activities @returns {ActivityGroup[]}
 */
export function groupActivities(activities) {
  /** @type {ActivityGroup[]} */
  const groups = [];
  for (const activity of activities) {
    if (isBackgroundActivity(activity)) continue;
    const phase = activityPhase(activity);
    const previous = groups.at(-1);
    if (continuesPhase(previous, activity, phase) && previous) {
      previous.count += activity.count ?? 1;
      previous.occurredAt = activity.occurredAt;
      Object.assign(previous, phase);
      previous.sourceDetail = activity.detail;
      previous.status = activity.status;
    } else groups.push({...phase, count: activity.count ?? 1, occurredAt: activity.occurredAt, status: activity.status, sourceDetail: activity.detail});
  }
  return groups;
}

/** A bounded streaming cursor: polling boundaries and usage ticks don't repeat a phase.
 * Distinct details (including commentary and file summaries), completion, and every error survive.
 * @param {number} [after]
 */
export function createActivityProgress(after = 0) {
  let sequence = after;
  /** @type {ActivityGroup | undefined} */
  let previous;
  /** @param {readonly Activity[]} events @returns {Activity[]} */
  return (events) => {
    const output = [];
    for (const activity of [...events].sort((a, b) => a.sequence - b.sequence)) {
      if (activity.sequence <= sequence) continue;
      sequence = activity.sequence;
      if (isBackgroundActivity(activity)) continue;
      const phase = activityPhase(activity);
      const continued = continuesPhase(previous, activity, phase);
      if (!continued || (activity.status === 'completed' && previous?.status !== 'completed')
        || (activity.detail && previous?.sourceDetail !== activity.detail)
        || (activity.kind === 'activity' && previous?.detail !== phase.detail)) {
        output.push({...activity, title: phase.title, detail: phase.detail});
      }
      previous = {...phase, count: 1, occurredAt: activity.occurredAt, status: activity.status, sourceDetail: activity.detail};
    }
    return output;
  };
}

/** @param {Activity} activity @returns {Phase} */
export function activityPhase(activity) {
  const fallback = activity.detail || activity.title;
  if (activity.status === 'failed' || activity.kind === 'error') {
    return { key: 'attention', icon: '!', title: 'Something needs attention', detail: fallback };
  }
  const phases = /** @type {Record<string, Phase>} */ ({
    plan: { key: 'plan', icon: '☷', title: 'Planning the work', detail: fallback },
    reasoning: { key: 'reasoning', icon: '◇', title: 'Thinking through the task', detail: fallback },
    web_search: { key: 'research', icon: '⌕', title: 'Researching the web', detail: fallback },
    computer: { key: 'browser', icon: '▣', title: 'Working in the browser', detail: fallback },
    command: { key: 'tools', icon: '›_', title: 'Using the workspace', detail: fallback },
    tool: { key: 'tools', icon: '◆', title: 'Using a tool', detail: fallback },
    file: { key: 'files', icon: '±', title: 'Updating files', detail: fallback },
    commentary: { key: 'commentary', icon: '↗', title: 'Progress update', detail: fallback },
    message: { key: 'answer', icon: '↗', title: 'Preparing the answer', detail: fallback },
    agent: { key: 'agent', icon: '●', title: activity.status === 'completed' ? 'Rat finished working' : 'Rat started working', detail: fallback },
    compaction: { key: 'context', icon: '↻', title: 'Keeping context focused', detail: 'Older context was compacted without losing durable conversation state.' },
    usage: { key: 'usage', icon: '#', title: 'Tracking Run usage', detail: fallback },
  });
  return phases[activity.kind] ?? { key: 'activity', icon: '·', title: activity.title || 'Working', detail: fallback };
}
