import {
  LambdaMicrovmsClient,
  TerminateMicrovmCommand,
} from '@aws-sdk/client-lambda-microvms';

const microvmId = process.env.MICROVM_ID;
if (!microvmId) process.exit(0);

const region = process.env.AWS_REGION;
const client = new LambdaMicrovmsClient(region ? { region } : {});
await client.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }));
