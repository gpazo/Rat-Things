import type { DemoResult } from './demo.js';

export function renderReport(
  data: Pick<DemoResult, 'original' | 'alternative' | 'correct' | 'summary'>,
): string {
  const payload = JSON.stringify({
    traces: { Original: data.original, Branch: data.alternative, Correct: data.correct },
    summary: data.summary,
  }).replaceAll('<', '\\u003c');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Command time travel · Rat Things</title>
    <link rel="stylesheet" href="brand.css">
    <style>
      @font-face {
        font-family: Inter;
        src: url('Inter-Regular.ttf');
        font-weight: 400;
      }
      @font-face {
        font-family: Inter;
        src: url('Inter-Medium.ttf');
        font-weight: 500;
      }
      @font-face {
        font-family: Inter;
        src: url('Inter-SemiBold.ttf');
        font-weight: 600;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        background: var(--rt-bg);
        color: var(--rt-text);
        font: 16px/1.6 var(--rt-font);
      }
      main {
        max-width: 1240px;
        margin: auto;
        padding: 40px 24px;
      }
      h1,
      h2,
      h3 {
        font-weight: 600;
        line-height: 1.15;
        letter-spacing: -0.02em;
      }
      h1 {
        font-size: 42px;
        margin: 8px 0 16px;
      }
      h2 {
        font-size: 22px;
      }
      p {
        color: var(--rt-text-secondary);
      }
      .kicker,
      .muted {
        color: var(--rt-muted);
      }
      .kicker {
        font-size: 14px;
        font-weight: 500;
      }
      .notice {
        border: 1px solid var(--rt-border-strong);
        border-radius: var(--rt-radius);
        padding: 16px;
        background: var(--rt-panel);
      }
      .compare {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 12px;
        margin: 28px 0;
      }
      .card {
        background: var(--rt-card);
        border: 1px solid var(--rt-border);
        border-radius: var(--rt-radius);
        padding: 20px;
      }
      .card strong {
        font-weight: 600;
        font-size: 32px;
        display: block;
      }
      .card p {
        margin: 0;
        font-size: 14px;
      }
      .card h2 {
        margin: 0 0 12px;
      }
      .selected {
        border-color: var(--rt-accent);
      }
      button,
      select {
        font: 500 14px var(--rt-font);
        min-height: 40px;
        border: 1px solid var(--rt-border-strong);
        border-radius: var(--rt-radius);
        padding: 8px 12px;
        background: var(--rt-card);
        color: var(--rt-text);
        cursor: pointer;
      }
      button:hover {
        background: var(--rt-hover);
      }
      button:focus-visible,
      select:focus-visible,
      input:focus-visible {
        outline: 2px solid var(--rt-accent);
        outline-offset: 3px;
      }
      .primary {
        background: var(--rt-primary-fill);
        color: var(--rt-primary-text);
      }
      .toolbar {
        display: flex;
        gap: 12px;
        align-items: center;
        flex-wrap: wrap;
      }
      input {
        accent-color: var(--rt-accent);
        width: 100%;
        margin: 24px 0;
      }
      .layout {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 16px;
      }
      .panel {
        background: var(--rt-panel);
        border: 1px solid var(--rt-border);
        border-radius: var(--rt-radius);
        padding: 20px;
        min-width: 0;
      }
      pre {
        font: 13px/1.55 var(--rt-mono);
        overflow: auto;
        max-height: 380px;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      #events {
        max-height: 420px;
        overflow: auto;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      #events button {
        text-align: left;
        font-weight: 400;
        font-family: var(--rt-mono);
        font-size: 12px;
      }
      #events button[aria-current='true'] {
        background: var(--rt-selected);
        border-color: var(--rt-accent);
      }
      .metrics {
        display: flex;
        gap: 24px;
        margin: 16px 0;
        color: var(--rt-text-secondary);
      }
      a {
        color: var(--rt-accent);
      }
      footer {
        color: var(--rt-muted);
        font-size: 13px;
        margin-top: 32px;
      }
      @media (max-width: 750px) {
        main {
          padding: 24px 16px;
        }
        h1 {
          font-size: 32px;
        }
        .compare,
        .layout {
          grid-template-columns: 1fr;
        }
        .metrics {
          flex-wrap: wrap;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <div class="kicker">Rat Things · Command time travel</div>
      <h1>See where one effect becomes two.</h1>
      <p>
        Replay a recorded schedule through the real command service. Select an event to inspect the durable
        records and external effect ledger at that boundary.
      </p>
      <div class="notice">
        The original uses <strong>unsafe-claim-cas</strong>, an intentionally broken test store. This witness
        demonstrates the simulator. It is not a production bug.
      </div>
      <div class="compare" id="comparison"></div>
      <div class="toolbar">
        <label for="trace">Trace</label
        ><select id="trace">
          <option>Original</option>
          <option>Branch</option>
          <option>Correct</option></select
        ><button id="previous">Previous event</button><button id="next" class="primary">Next event</button
        ><span id="position" class="muted"></span>
      </div>
      <input id="timeline" type="range" min="1" aria-label="Event timeline" />
      <div class="metrics">
        <span id="effect-count"></span><span id="clock"></span><span id="durable"></span>
      </div>
      <div class="layout">
        <section class="panel">
          <h2>Recorded schedule</h2>
          <div id="events"></div>
        </section>
        <section class="panel">
          <h2 id="detail-title">Event details</h2>
          <pre id="details"></pre>
          <h2>Durable state</h2>
          <pre id="state"></pre>
          <h2>External effect ledger</h2>
          <pre id="effects"></pre>
        </section>
      </div>
      <section class="panel" style="margin-top: 16px">
        <h2>Verified demonstration</h2>
        <p id="proof"></p>
        <a href="summary.json">Read the machine report</a> ·
        <a id="trace-link" href="original.json">Download selected trace</a>
      </section>
      <footer>
        One synthetic command. Atomic in-memory storage. Bounded schedules, actors and crashes. No AWS or
        model calls. No exhaustive guarantee. The controls inspect saved execution data.
      </footer>
    </main>
    <script type="application/json" id="data">
      ${payload}
    </script>
    <script>
      const data = JSON.parse(document.getElementById('data').textContent);
      const selector = document.getElementById('trace');
      const slider = document.getElementById('timeline');
      let position = 1;
      const text = (id, value) => (document.getElementById(id).textContent = value);
      function render() {
        const trace = data.traces[selector.value];
        position = Math.min(Math.max(1, position), trace.events.length);
        slider.max = trace.events.length;
        slider.value = position;
        const event = trace.events[position - 1];
        text('position', 'Event ' + position + ' of ' + trace.events.length);
        text('effect-count', 'Effects applied: ' + event.world.effects.length);
        text('clock', 'Virtual time: ' + event.world.now);
        text('durable', 'Durable records: ' + event.world.resources.length);
        text('detail-title', 'Event ' + position + ' · ' + event.choice.kind);
        text(
          'details',
          JSON.stringify(
            { choice: event.choice, observations: event.observations, worldHash: event.worldHash },
            null,
            2,
          ),
        );
        text('state', JSON.stringify(event.world.resources, null, 2));
        text('effects', JSON.stringify(event.world.effects, null, 2));
        document.getElementById('events').replaceChildren(
          ...trace.events.map((event) => {
            const button = document.createElement('button');
            button.textContent = event.index + '. ' + JSON.stringify(event.choice);
            button.setAttribute('aria-current', String(event.index === position));
            button.onclick = () => {
              position = event.index;
              render();
            };
            return button;
          }),
        );
        document.getElementById('trace-link').href = selector.value.toLowerCase() + '.json';
        document.getElementById('comparison').replaceChildren(
          ...Object.entries(data.traces).map(([name, trace]) => {
            const card = document.createElement('section');
            card.className = 'card' + (name === selector.value ? ' selected' : '');
            const heading = document.createElement('h2');
            heading.textContent = name;
            const count = document.createElement('strong');
            count.textContent = trace.result.effects + ' effect' + (trace.result.effects === 1 ? '' : 's');
            const description = document.createElement('p');
            description.textContent =
              name === 'Original'
                ? 'Injected broken claim fence'
                : name === 'Branch'
                  ? 'Same prefix, crash before effect'
                  : 'Real compare-and-swap fence';
            card.append(heading, count, description);
            return card;
          }),
        );
      }
      selector.onchange = () => {
        position = data.traces[selector.value].events.length;
        render();
      };
      slider.oninput = () => {
        position = Number(slider.value);
        render();
      };
      document.getElementById('previous').onclick = () => {
        position--;
        render();
      };
      document.getElementById('next').onclick = () => {
        position++;
        render();
      };
      const s = data.summary;
      text(
        'proof',
        'Seed ' +
          s.search.seed +
          ' found the witness after ' +
          s.search.runs +
          ' run(s). Replay verified. The branch preserves events 1–' +
          s.branch.at +
          '. Minimization reduced ' +
          s.minimization.originalSteps +
          ' events to ' +
          s.minimization.minimizedSteps +
          ' by rerunning candidates, including actor removal. For the correct fence, ' +
          s.correct.freshSearch.runs +
          ' bounded runs found no invariant violation. Lost acknowledgement, crash, deadline, stale target and tamper checks passed.',
      );
      position = data.traces.Original.events.length;
      render();
    </script>
  </body>
</html>`;
}
