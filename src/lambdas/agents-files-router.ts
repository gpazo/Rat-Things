import type { FileService } from '../core/file-service.js';
import type { SkillService } from '../core/skill-service.js';
import { AgentsApiError, parseAgentsContract } from '../domain/agents-api-validation.js';
import { json, queryParameters, requestBody } from './agents-router.js';

export async function routeUploadedFiles(request: Request, ownerId: string, parts: string[], files: FileService | undefined, requestId?: string): Promise<Response> {
  if (!files) throw new AgentsApiError(503, 'File service is unavailable.', 'service_unavailable');
  const [id, operation] = parts;
  if (parts.length === 0 && request.method === 'GET') return json(200, await files.list(ownerId, parseAgentsContract('UploadedFileList', queryParameters(new URL(request.url).searchParams))), requestId);
  if (parts.length === 0 && request.method === 'POST') {
    const form = await multipart(request);
    rejectFields(form, ['file', 'purpose', 'expires_after[anchor]', 'expires_after[seconds]']);
    const file = form.get('file');
    if (!(file instanceof File)) throw new AgentsApiError(400, 'A file upload is required.', 'invalid_request', 'file');
    const input = parseAgentsContract('UploadedFileCreate', {
      purpose: form.get('purpose'),
      ...(form.has('expires_after[anchor]') || form.has('expires_after[seconds]') ? { expires_after: { anchor: form.get('expires_after[anchor]'), seconds: Number(form.get('expires_after[seconds]')) } } : {}),
    });
    return json(200, await files.create(ownerId, { ...input, filename: file.name, data: new Uint8Array(await file.arrayBuffer()) }), requestId);
  }
  if (id && parts.length === 1 && request.method === 'GET') return json(200, await files.retrieve(ownerId, id), requestId);
  if (id && parts.length === 1 && request.method === 'DELETE') return json(200, await files.delete(ownerId, id), requestId);
  if (id && operation === 'content' && parts.length === 2 && request.method === 'GET') return bytes(await files.content(ownerId, id), 'application/octet-stream', requestId);
  throw new AgentsApiError(404, 'Route not found.', 'resource_not_found');
}

export async function routeSkills(request: Request, ownerId: string, parts: string[], skills: SkillService | undefined, requestId?: string): Promise<Response> {
  if (!skills) throw new AgentsApiError(503, 'Skill service is unavailable.', 'service_unavailable');
  const [id, operation, version, child] = parts;
  const method = request.method;
  const query = () => queryParameters(new URL(request.url).searchParams);
  if (!id && method === 'GET') return json(200, await skills.list(ownerId, parseAgentsContract('SkillList', query())), requestId);
  if (!id && method === 'POST') return json(200, await skills.create(ownerId, (await skillFiles(request)).files), requestId);
  if (id && parts.length === 1) {
    if (method === 'GET') return json(200, await skills.retrieve(ownerId, id), requestId);
    if (method === 'DELETE') return json(200, await skills.delete(ownerId, id), requestId);
    if (method === 'POST') return json(200, await skills.update(ownerId, id, parseAgentsContract('SkillUpdate', await requestBody(request)).default_version), requestId);
  }
  if (id && operation === 'content' && parts.length === 2 && method === 'GET') return bytes(await skills.content(ownerId, id), 'application/zip', requestId);
  if (id && operation === 'versions') {
    if (parts.length === 2 && method === 'GET') return json(200, await skills.versions(ownerId, id, parseAgentsContract('SkillVersionList', query())), requestId);
    if (parts.length === 2 && method === 'POST') { const upload = await skillFiles(request); return json(200, await skills.createVersion(ownerId, id, upload.files, upload.default), requestId); }
    if (version && parts.length === 3 && method === 'GET') return json(200, await skills.version(ownerId, id, version), requestId);
    if (version && parts.length === 3 && method === 'DELETE') return json(200, await skills.deleteVersion(ownerId, id, version), requestId);
    if (version && child === 'content' && parts.length === 4 && method === 'GET') return bytes(await skills.content(ownerId, id, version), 'application/zip', requestId);
  }
  throw new AgentsApiError(404, 'Route not found.', 'resource_not_found');
}

async function skillFiles(request: Request) {
  const form = await multipart(request);
  rejectFields(form, ['files', 'files[]', 'default'], ['files', 'files[]']);
  const files = [...form.getAll('files'), ...form.getAll('files[]')];
  if (!files.length || files.some((file) => !(file instanceof File))) throw new AgentsApiError(400, 'Skill files are required.', 'invalid_request', 'files');
  const makeDefault = form.get('default');
  if (makeDefault !== null && !['true', 'false'].includes(String(makeDefault))) throw new AgentsApiError(400, 'default must be a boolean.', 'invalid_request', 'default');
  return { files: await Promise.all(files.map(async (file) => ({ path: (file as File).name, data: new Uint8Array(await (file as File).arrayBuffer()) }))), default: makeDefault === 'true' };
}
async function multipart(request: Request) {
  try { return await request.formData(); } catch { throw new AgentsApiError(400, 'A multipart upload is required.', 'invalid_request'); }
}
function rejectFields(form: FormData, allowed: string[], repeated: string[] = []) {
  const names = new Set<string>();
  form.forEach((_value, name) => names.add(name));
  for (const name of names) if (!allowed.includes(name) || !repeated.includes(name) && form.getAll(name).length !== 1) throw new AgentsApiError(400, 'Invalid upload field.', 'invalid_request', name);
}
function bytes(content: AsyncIterable<Uint8Array>, type: string, requestId?: string): Response {
  const iterator = content[Symbol.asyncIterator]();
  return new Response(new ReadableStream({ async pull(controller) { const next = await iterator.next(); if (next.done) controller.close(); else controller.enqueue(next.value); }, async cancel() { await iterator.return?.(); } }), {
    headers: { 'content-type': type, 'cache-control': 'no-store', ...(requestId ? { 'x-request-id': requestId } : {}) },
  });
}
