import { setTimeout as delay } from 'node:timers/promises';
import type OpenAI from 'openai';
import type { AgentSession } from '../../src/domain/agents-api.js';
import { renderPreview } from '../../site/fork-demo/themes.js';
import type { DemoBackend, Theme } from './controller.js';
const directions = {
  paper:
    'Warm editorial: cream paper, terracotta accents, generous space, expressive serif headlines. Quiet, tactile, thoughtful.',
  midnight:
    'Bold after-hours: deep navy, electric lime accents, large geometric sans-serif headlines, rounded cards. Confident, vivid, energetic.',
};
export class AgentsForkDemoBackend implements DemoBackend {
  public constructor(
    private readonly api: OpenAI,
    private readonly model: string,
  ) {}
  public async createAgent() {
    return (
      await this.api.beta.agents.create(
        {
          name: 'Fieldnotes fork demo',
          model: this.model,
          tools: [],
          instructions:
            'You are a careful UI designer. Work with self-contained HTML and inline CSS. Do not use scripts, external assets, libraries, or network access. Preserve the Fieldnotes product and its note-taking purpose.',
        },
        { maxRetries: 0 },
      )
    ).id;
  }
  public async createSource(agentId: string) {
    return (
      await this.api.beta.agents.sessions.create(
        {
          agent_id: agentId,
          metadata: { demo: 'fieldnotes-fork', path: 'original' },
          environment: {
            type: 'openai_hosted',
            network: { access: 'disabled' },
            files: [
              {
                type: 'inline',
                path: '/workspace/index.html',
                data: Buffer.from(renderPreview('starter')).toString('base64'),
              },
            ],
          },
          input:
            'Read /workspace/index.html. Remember our brief: Fieldnotes is a quiet home for ideas, with Collect and Connect feature cards. Keep the file unchanged. Copy it to /workspace/outputs/index.html, creating the directory if needed, and answer READY.',
        },
        { maxRetries: 0 },
      )
    ).id;
  }
  public async fork(sourceId: string, theme: Theme) {
    const session = await this.api.post<AgentSession>(
      `/agents/sessions/${sourceId}/fork`,
      {
        maxRetries: 0,
        body: {
          metadata: { demo: 'fieldnotes-fork', path: theme },
          input: `Use the inherited brief and /workspace/index.html. Take this design direction: ${directions[theme]} Rewrite /workspace/index.html as a polished self-contained landing page under 100 KB, using inline CSS. Preserve the brand, feature cards, and product purpose. It must look good in a 520px-wide preview and on mobile. Copy the finished file to /workspace/outputs/index.html so it becomes a saved artifact. Briefly summarize the design.`,
        },
      },
    );
    return session.id;
  }
  public async wait(sessionId: string) {
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      const session = await this.api.beta.agents.sessions.retrieve(sessionId);
      if (
        session.error ||
        (session.status === 'requires_action' &&
          session.required_actions.some(
            (action) => action.type !== 'environment_connection',
          ))
      )
        throw new Error(
          `Session ${sessionId} needs attention: ${JSON.stringify(session.error ?? session.required_actions)}`,
        );
      for await (const turn of this.api.beta.agents.sessions.turns.list(
        sessionId,
      )) {
        if (turn.subagent_id !== null) continue;
        if (turn.status === 'completed') return;
        if (turn.status === 'failed' || turn.status === 'cancelled')
          throw new Error(
            `Session ${sessionId} stopped: ${JSON.stringify(turn.error)}`,
          );
      }
      await delay(2000);
    }
    throw new Error(
      `Session ${sessionId} did not finish within ten minutes. Use cleanup to close it.`,
    );
  }
  public async preview(sessionId: string) {
    for await (const artifact of this.api.beta.agents.sessions.artifacts.list(
      sessionId,
    )) {
      if (artifact.path !== '/workspace/outputs/index.html') continue;
      if (artifact.size_bytes > 256 * 1024)
        throw new Error('The demo preview exceeds 256 KiB.');
      const html = await (
        await this.api.beta.agents.sessions.artifacts.content(artifact.id, {
          session_id: sessionId,
        })
      ).text();
      if (!html.trim() || Buffer.byteLength(html) > 256 * 1024)
        throw new Error('Invalid demo preview.');
      return html;
    }
    throw new Error(
      `Session ${sessionId} did not publish /workspace/outputs/index.html.`,
    );
  }
  public async deleteSession(id: string) {
    await this.ignoreMissing(() => this.api.beta.agents.sessions.delete(id));
  }
  public async deleteAgent(id: string) {
    await this.ignoreMissing(() => this.api.beta.agents.delete(id));
  }
  private async ignoreMissing(operation: () => Promise<unknown>) {
    try {
      await operation();
    } catch (error) {
      if (
        !(
          typeof error === 'object' &&
          error !== null &&
          'status' in error &&
          error.status === 404
        )
      )
        throw error;
    }
  }
}
