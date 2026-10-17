import { expect, it } from 'vitest';
import { demo } from '../../testing/time-travel/cli.js';
import { hash, type Provenance } from '../../testing/time-travel/model.js';

const provenance: Provenance = {
  sources: { baseline: '0'.repeat(64) },
  runtime: { node: 'fixed', tsx: 'fixed', platform: 'fixed', arch: 'fixed' },
  git: 'fixed',
};

it('preserves the complete demo with fixed provenance', async () => {
  const result = await demo(provenance);

  expect(Object.fromEntries(Object.entries(result).map(([name, value]) => [name, hash(value)]))).toEqual({
    original: '83d673b11e6efca884e8d1e410f7d2dc9ca135fd0b6f9bc1879d019796715188',
    alternative: 'ee2e22c6370772d220099ba1bf34fa539948c38b0c374766b5b2ef4e9ceee818',
    minimized: '949768a5ee678bac0e0d3cf558272897367735adf089b60bb52178820cc2714b',
    correct: '2ab10c88cc8d13d130381b31b534619b7f737e72035f2a399e3d067a0efd7d66',
    lostAck: '1d00e38cc3e0a38227e7bb200ea90208411d8fe5c887b85d723cdb6c7f2cb6dc',
    deadline: 'ac5282af5d0f5695560f9cd921d3c6c7363fd419398ba5044081d17994dafaf2',
    stale: '8c7f49cb9b8a07722d48d74da159df5b85fb1dda2313a69169ab6b42521e15c6',
    summary: '14e88b153dbf0b69fd115deed0d2e10bbcb30e511784744008670dfdf5c58c8e',
  });
});
