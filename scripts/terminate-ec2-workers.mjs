import { EC2Client, DescribeInstancesCommand, TerminateInstancesCommand } from '@aws-sdk/client-ec2';
import { pathToFileURL } from 'node:url';

export function deploymentWorkers(instances, deployment, launchTemplateId) {
  return instances.filter(instance => {
    const tags = Object.fromEntries((instance.Tags ?? []).map(tag => [tag.Key, tag.Value]));
    return instance.InstanceId && instance.State?.Name !== 'terminated'
      && tags.RatDeployment === deployment && tags.RatRunId && tags.RatGeneration
      && tags['aws:ec2launchtemplate:id'] === launchTemplateId;
  });
}

export async function terminateDeploymentWorkers(client, deployment, launchTemplateId, options = {}) {
  if (!deployment || !launchTemplateId) throw new Error('An exact deployment and launch template are required.');
  const now = options.now ?? Date.now;
  const delay = options.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = now() + (options.timeoutMs ?? 180_000);
  let emptyPasses = 0;
  const touched = new Set();
  while (now() < deadline) {
    const instances = [];
    let nextToken;
    do {
      const page = await client.send(new DescribeInstancesCommand({
        Filters: [{ Name: 'tag:RatDeployment', Values: [deployment] }],
        ...(nextToken ? { NextToken: nextToken } : {}),
      }));
      instances.push(...(page.Reservations ?? []).flatMap(reservation => reservation.Instances ?? []));
      nextToken = page.NextToken;
    } while (nextToken);
    const active = deploymentWorkers(instances, deployment, launchTemplateId);
    emptyPasses = active.length === 0 ? emptyPasses + 1 : 0;
    if (emptyPasses >= 2) return touched.size;
    const ids = active.filter(instance => instance.State?.Name !== 'shutting-down').map(instance => instance.InstanceId);
    if (ids.length) {
      await client.send(new TerminateInstancesCommand({ InstanceIds: ids }));
      ids.forEach(id => touched.add(id));
    }
    await delay(2_000);
  }
  throw new Error('EC2 workers did not terminate before the teardown deadline.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [region, deployment, launchTemplateId] = process.argv.slice(2);
  if (!region) throw new Error('AWS region is required.');
  const client = new EC2Client({ region, maxAttempts: 3, requestHandler: { connectionTimeout: 5_000, requestTimeout: 10_000, throwOnRequestTimeout: true } });
  try {
    const count = await terminateDeploymentWorkers(client, deployment, launchTemplateId);
    console.log(`Terminated ${count} disposable EC2 Session worker(s).`);
  } finally { client.destroy(); }
}
