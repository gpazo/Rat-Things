import { chown, mkdir, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { MAX_ARTIFACT_FILES, validateArtifactPath } from '../domain/artifacts.js';
import { AGENT_ARTIFACT_DIRECTORY } from './artifact-planning.js';
import { agentProcessIdentity } from './agent-identity.js';

export async function prepareArtifactDirectory(workspace: string): Promise<string> {
  const control = controlRoot(workspace);
  await mkdir(control, { recursive: true, mode: 0o700 });
  await handoff(control);
  const root = artifactRoot(workspace);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await handoff(root);
  return root;
}

export async function localArtifactPaths(workspace: string): Promise<string[]> {
  return listArtifactPaths(await prepareArtifactDirectory(workspace));
}

function artifactRoot(workspace: string): string {
  return resolve(workspace, AGENT_ARTIFACT_DIRECTORY);
}

function controlRoot(workspace: string): string {
  return resolve(workspace, '.rat-things');
}

async function listArtifactPaths(root: string): Promise<string[]> {
  const paths: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).split(sep).join('/');
      validateArtifactPath(path);
      if (entry.isSymbolicLink()) throw new Error(`artifact ${path} cannot be a symbolic link`);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        paths.push(path);
        if (paths.length > MAX_ARTIFACT_FILES) return;
      } else {
        throw new Error(`artifact ${path} is not a regular file`);
      }
    }
  };
  await visit(root);
  return paths.sort();
}

async function handoff(path: string): Promise<void> {
  const identity = configuredAgentIdentity();
  if (identity) await chown(path, identity.uid, identity.gid);
}

function configuredAgentIdentity(): { uid: number; gid: number } | undefined {
  return agentProcessIdentity(process.env.RUN_AGENT_UID, process.env.RUN_AGENT_GID);
}
