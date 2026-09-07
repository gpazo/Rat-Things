// @ts-check

/** @typedef {{ label: string, title: string, detail: string }} RunPresentation */
/** @satisfies {Record<string, RunPresentation>} */
const states = {
  queued: { label: 'Queued', title: 'Queued for isolated execution', detail: 'Your message is durable and waiting for a worker.' },
  dispatching: { label: 'Starting', title: 'Starting isolated environment', detail: 'Preparing the isolated environment and durable workspace. First-use storage can take tens of seconds.' },
  running: { label: 'Working', title: 'Agent is working', detail: 'The agent is processing this turn.' },
  cancelling: { label: 'Stopping', title: 'Stopping safely', detail: 'The agent is stopping and saving available work.' },
  succeeded: { label: 'Done', title: 'Work completed', detail: 'The response and conversation state are durable.' },
  failed: { label: 'Failed', title: 'Work failed', detail: 'Review the recorded failure and any saved output.' },
  cancelled: { label: 'Stopped', title: 'Work stopped', detail: 'Review any saved output before continuing.' },
};

/**
 * User-facing Run states shared by the console and CLI. Readiness comes from the live
 * endpoint; a running allocation alone does not mean the agent is ready.
 * @param {{ status?: string, ready?: boolean, pendingRequests?: readonly unknown[], latestProgress?: string | null, settling?: boolean }} work
 * @returns {RunPresentation}
 */
export function runPresentation(work) {
  const status = work.status ?? 'queued';
  const presentation = states[/** @type {keyof typeof states} */ (status)] ?? states.queued;
  if (work.settling && status === 'succeeded') return { label: 'Saving', title: 'Saving conversation', detail: 'The agent finished; saving the result before continuing.' };
  if (['cancelling', 'succeeded', 'failed', 'cancelled'].includes(status)) return presentation;
  if (work.pendingRequests?.length) return { label: 'Needs input', title: 'Agent needs input', detail: 'Answer the question to continue.' };
  if (status === 'running' && work.ready === false) return { ...states.dispatching, detail: 'Connecting to the agent runtime.' };
  if (status === 'running' && work.latestProgress) return { ...states.running, title: work.latestProgress };
  return presentation;
}

/** @param {string} mediaType */
export function isTextArtifact(mediaType) {
  const type = (mediaType.split(';')[0] ?? '').trim().toLowerCase();
  return type.startsWith('text/') || ['application/json', 'application/xml', 'application/yaml', 'application/x-yaml'].includes(type) || type.endsWith('+json') || type.endsWith('+xml');
}

/** Quote one argument for the POSIX shell commands shown by both clients. @param {string} value */
export function shellArgument(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** @param {string} thread @param {{id: string, path: string, mediaType: string}} file */
export function fileCommands(thread, file) {
  const base = `rat-things file ${shellArgument(file.id)} --thread ${shellArgument(thread)}`;
  return [
    ...(isTextArtifact(file.mediaType) ? [['Preview in terminal', `${base} --preview`]] : []),
    ['Open in browser', `${base} --open`],
    ['Download a copy', `${base} --download ${shellArgument(`./${file.path.split('/').at(-1) || 'download'}`)}`],
  ];
}

/** @param {number} bytes */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/** Read a bounded text preview without buffering the whole file. @param {Response} response @param {number} maximum */
export async function readTextPreview(response, maximum) {
  const reader = response.body?.getReader();
  if (!reader) return {text: '', truncated: false};
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) return {text: text + decoder.decode(), truncated: false};
      const remaining = maximum - bytes;
      text += decoder.decode(value.subarray(0, remaining), {stream: true});
      bytes += value.byteLength;
      if (bytes > maximum) return {text: text + decoder.decode(), truncated: true};
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
