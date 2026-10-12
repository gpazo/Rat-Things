import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type Theme = 'paper' | 'midnight';
export interface DemoBranch {
  key: Theme;
  sessionId?: string;
  html?: string | null;
  discarded?: boolean;
}
export interface DemoState {
  phase:
    | 'empty'
    | 'preparing'
    | 'ready'
    | 'forking'
    | 'comparing'
    | 'choosing'
    | 'chosen'
    | 'cleaning'
    | 'error';
  busy: boolean;
  status: string;
  error: string | null;
  agentId?: string;
  source: { sessionId: string } | null;
  branches: DemoBranch[];
  winner: Theme | null;
}
export interface DemoBackend {
  createAgent(): Promise<string>;
  createSource(agentId: string): Promise<string>;
  fork(sourceId: string, theme: Theme): Promise<string>;
  wait(sessionId: string): Promise<void>;
  preview(sessionId: string): Promise<string>;
  deleteSession(sessionId: string): Promise<void>;
  deleteAgent(agentId: string): Promise<void>;
}
const empty = (): DemoState => ({
  phase: 'empty',
  busy: false,
  status: 'Ready to prepare a real Session.',
  error: null,
  source: null,
  branches: [],
  winner: null,
});

/** One local demonstration owns only IDs recorded by its own creation calls. */
export class ForkDemoController {
  public state = empty();
  private active = false;
  public constructor(
    private readonly backend: DemoBackend,
    private readonly file: string,
    private readonly deployment: string,
  ) {}
  public async restore() {
    const saved = await readFile(this.file, 'utf8').catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      },
    );
    if (!saved) return;
    const record = JSON.parse(saved) as {
      deployment: string;
      state: DemoState;
    };
    if (record.deployment !== this.deployment)
      throw new Error(
        'The saved demo belongs to another deployment. Use a different FORK_DEMO_STATE_FILE.',
      );
    this.state = record.state;
    if (this.state.busy) {
      this.state = {
        ...this.state,
        phase: 'error',
        busy: false,
        error:
          'The server stopped during an operation. Clean up the recorded demo Sessions before starting again.',
        status: 'Interrupted demo. Cleanup is available.',
      };
      await this.save();
    }
  }
  public validate(action: string, key?: unknown): void {
    if (this.active || this.state.busy)
      throw new Error('A demo operation is already running.');
    if (action === 'start' && this.state.phase !== 'empty')
      throw new Error('Clean up the current demo before starting another.');
    if (action === 'fork' && this.state.phase !== 'ready')
      throw new Error('Prepare the source before forking.');
    if (
      action === 'choose' &&
      (this.state.phase !== 'comparing' ||
        !['paper', 'midnight'].includes(String(key)))
    )
      throw new Error('Choose one of the two completed paths.');
    if (!['start', 'fork', 'choose', 'cleanup'].includes(action))
      throw new Error('Unknown demo action.');
  }
  public async action(action: string, key?: unknown): Promise<void> {
    this.validate(action, key);
    // Set admission synchronously so a second request cannot create another job.
    this.active = true;
    this.state = { ...this.state, busy: true, error: null };
    try {
      if (action === 'start') await this.start();
      else if (action === 'fork') await this.fork();
      else if (action === 'choose') await this.choose(key as Theme);
      else await this.cleanup();
    } catch (error) {
      this.state = {
        ...this.state,
        phase: 'error',
        error:
          error instanceof Error
            ? error.message.slice(0, 1000)
            : 'Demo operation failed.',
        status: 'The operation stopped. Recorded Sessions can be cleaned up.',
      };
    } finally {
      this.state = { ...this.state, busy: false };
      try {
        await this.save();
      } finally {
        this.active = false;
      }
    }
  }
  private async start() {
    this.state = {
      ...this.state,
      phase: 'preparing',
      status: 'Preparing Fieldnotes and its shared design brief…',
    };
    await this.save();
    this.state.agentId = await this.backend.createAgent();
    await this.save();
    this.state.source = {
      sessionId: await this.backend.createSource(this.state.agentId),
    };
    await this.save();
    await this.backend.wait(this.state.source.sessionId);
    this.state = {
      ...this.state,
      phase: 'ready',
      status: 'Original Session ready. Fork it into two design directions.',
    };
  }
  private async fork() {
    if (!this.state.source) throw new Error('Source Session is missing.');
    const sourceId = this.state.source.sessionId;
    this.state = {
      ...this.state,
      phase: 'forking',
      branches: [{ key: 'paper' }, { key: 'midnight' }],
      status: 'Checkpointing the source and creating Paper & ink…',
    };
    await this.save();
    // Sequential creation waits for source admission to reopen after snapshot publication.
    for (const branch of this.state.branches) {
      branch.sessionId = await this.backend.fork(sourceId, branch.key);
      await this.save();
      this.state.status = `Designing ${branch.key === 'paper' ? 'Paper & ink' : 'After hours'} in its own Session…`;
      await this.save();
      await this.backend.wait(branch.sessionId);
      branch.html = await this.backend.preview(branch.sessionId);
      await this.save();
    }
    this.state = {
      ...this.state,
      phase: 'comparing',
      status: 'Two real forks. Choose one to keep and delete the other child.',
    };
  }
  private async choose(key: Theme) {
    const loser = this.state.branches.find((branch) => branch.key !== key);
    const winner = this.state.branches.find((branch) => branch.key === key);
    if (!loser?.sessionId || !winner?.html)
      throw new Error('Both paths must be ready before choosing.');
    this.state = {
      ...this.state,
      phase: 'choosing',
      status: 'Deleting the unchosen child Session…',
    };
    await this.save();
    await this.backend.deleteSession(loser.sessionId);
    loser.discarded = true;
    loser.html = null;
    this.state = {
      ...this.state,
      phase: 'chosen',
      winner: key,
      status:
        'Your chosen Session is ready to continue. The other child is deleted.',
    };
  }
  private async cleanup() {
    this.state = {
      ...this.state,
      phase: 'cleaning',
      status: 'Closing the demo Sessions and removing the demo Agent…',
    };
    await this.save();
    for (const branch of this.state.branches) {
      if (branch.sessionId && !branch.discarded) {
        await this.backend.deleteSession(branch.sessionId);
        branch.discarded = true;
        await this.save();
      }
    }
    if (this.state.source) {
      await this.backend.deleteSession(this.state.source.sessionId);
      this.state.source = null;
      await this.save();
    }
    if (this.state.agentId) await this.backend.deleteAgent(this.state.agentId);
    this.state = empty();
  }
  private async save() {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    await writeFile(
      `${this.file}.tmp`,
      JSON.stringify({ deployment: this.deployment, state: this.state }),
      { mode: 0o600 },
    );
    await rename(`${this.file}.tmp`, this.file);
  }
}
