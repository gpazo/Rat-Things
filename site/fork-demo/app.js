import { renderPreview, themes } from './themes.js';
const $ = (id) => document.getElementById(id);
const live = new URLSearchParams(location.search).get('mode') === 'live';
const empty = () => ({
  phase: 'empty',
  busy: false,
  status: 'One prepared workspace. Ready for a new direction.',
  source: null,
  branches: [],
  winner: null,
  error: null,
});
let state = empty(),
  lastRender = '',
  downloadUrl;
const preview = (frame, html) => {
  // Generated documents run without scripts, forms, same-origin access or external assets.
  const document = new DOMParser().parseFromString(html, 'text/html');
  document
    .querySelectorAll(
      'script, iframe, object, embed, base, link, meta[http-equiv]',
    )
    .forEach((node) => node.remove());
  for (const node of document.querySelectorAll('*')) {
    for (const attribute of [...node.attributes]) {
      if (
        /^on/i.test(attribute.name) ||
        /^(href|xlink:href|action|formaction|srcset|poster)$/i.test(
          attribute.name,
        )
      )
        node.removeAttribute(attribute.name);
      if (attribute.name === 'src' && !attribute.value.startsWith('data:'))
        node.removeAttribute(attribute.name);
    }
  }
  const policy = document.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content =
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; form-action 'none'; base-uri 'none'";
  document.head.prepend(policy);
  frame.srcdoc = '<!doctype html>' + document.documentElement.outerHTML;
};
preview($('source-preview'), renderPreview('starter'));
if (live) {
  $('mode').textContent = 'Live demo · real AWS Sessions';
  $('start-note').textContent = 'Creates a managed Session in your deployment.';
  $('explanation').textContent =
    'Real forks, generated designs, and saved HTML artifacts. Choosing a theme deletes the other child Session.';
  $('reset').textContent = 'Clean up demo sessions';
}
function render() {
  const fingerprint = JSON.stringify(state);
  if (fingerprint === lastRender) return;
  lastRender = fingerprint;
  $('status').textContent = state.status;
  $('error').hidden = !state.error;
  $('error').textContent = state.error ?? '';
  $('start').hidden = state.phase !== 'empty';
  $('fork').hidden = state.phase !== 'ready';
  $('starter').hidden = state.branches.length > 0;
  $('branches').hidden = !state.branches.length;
  $('result').hidden = !state.winner;
  $('reset').hidden = state.phase === 'empty';
  $('reset').disabled = state.busy;
  $('start').disabled = state.busy;
  $('fork').disabled = state.busy;
  $('stage-title').textContent = state.winner
    ? 'A direction worth keeping'
    : state.branches.length
      ? 'Same beginning. Different destinations.'
      : 'A good place to start';
  document
    .querySelectorAll('[data-step]')
    .forEach((step) =>
      step.classList.toggle(
        'active',
        Number(step.dataset.step) ===
          (state.winner ? 3 : state.branches.length ? 2 : 1),
      ),
    );
  $('branches').replaceChildren();
  for (const branch of state.branches) {
    const theme = themes[branch.key];
    const card = document.createElement('article');
    card.className = `branch ${branch.discarded ? 'discarded' : state.winner === branch.key ? 'kept' : ''}`;
    card.dataset.branch = branch.key;
    if (branch.discarded) {
      card.innerHTML = '<span class="discard-icon">↗</span><h2></h2><p></p>';
      card.querySelector('h2').textContent = `${theme.name}, let go.`;
      card.querySelector('p').textContent = live
        ? 'This child Session was deleted. Your chosen direction is independent.'
        : 'This path is discarded in the walkthrough. Your chosen direction stays intact.';
    } else {
      card.innerHTML =
        '<div class="branch-head"><div><span class="label"></span><h2></h2><p></p></div><div class="swatches"></div></div><div class="preview-wrap"><div class="browser-bar"><i></i><i></i><i></i><span></span></div><iframe sandbox=""></iframe></div><div class="branch-bottom"><span></span><button class="choose"></button></div>';
      card.querySelector('.label').textContent =
        branch.key === 'paper'
          ? 'PATH A / WARM & EDITORIAL'
          : 'PATH B / BOLD & ELECTRIC';
      card.querySelector('h2').textContent = theme.name;
      card.querySelector('.branch-head p').textContent =
        'Shared starting point. Independent workspace.';
      for (const color of [theme.background, theme.ink, theme.accent]) {
        const swatch = document.createElement('i');
        swatch.style.background = color;
        card.querySelector('.swatches').append(swatch);
      }
      card.querySelector('.browser-bar span').textContent =
        `fieldnotes / ${branch.key}`;
      const frame = card.querySelector('iframe');
      frame.title = `${theme.name} design`;
      if (branch.html) preview(frame, branch.html);
      else {
        frame.hidden = true;
        const pending = document.createElement('p');
        pending.className = 'pending';
        pending.textContent = 'Creating this direction…';
        card.querySelector('.preview-wrap').append(pending);
      }
      card.querySelector('.branch-bottom>span').textContent =
        state.winner === branch.key
          ? '✓ Your continuing Session'
          : branch.html
            ? 'The original stays unchanged.'
            : 'Your files and context come along.';
      const button = card.querySelector('.choose');
      button.textContent = `Keep ${theme.name} ↗`;
      button.setAttribute(
        'aria-label',
        `Keep ${theme.name} and discard the other path`,
      );
      button.disabled = state.busy || state.phase !== 'comparing';
      button.hidden = Boolean(state.winner);
      button.onclick = () => act('choose', branch.key);
    }
    $('branches').append(card);
  }
  if (downloadUrl) {
    URL.revokeObjectURL(downloadUrl);
    downloadUrl = undefined;
  }
  if (state.winner) {
    const branch = state.branches.find((item) => item.key === state.winner);
    $('result-title').textContent = `${themes[state.winner].name}. Keep going.`;
    $('result-copy').textContent = live
      ? 'The other child is deleted. Continue this Session through the API or CLI, or download its design.'
      : 'Your chosen design is ready to download. In live mode, its Session keeps the conversation and files.';
    $('session-id').hidden = !live;
    $('session-id').textContent = branch.sessionId ?? '';
    downloadUrl = URL.createObjectURL(
      new Blob([branch.html], { type: 'text/html' }),
    );
    $('download').href = downloadUrl;
  }
}
async function refresh() {
  const response = await fetch('./api/state', { cache: 'no-store' });
  if (!response.ok)
    throw new Error(
      'The live demo server is unavailable. Start npm run demo:fork -- --live.',
    );
  state = await response.json();
  render();
}
async function act(action, key) {
  if (state.busy) return;
  try {
    if (live) {
      state = { ...state, busy: true, error: null };
      render();
      const response = await fetch('./api/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, key }),
      });
      if (!response.ok)
        throw new Error(
          (await response.json()).error ?? 'The action could not be completed.',
        );
      await refresh();
    } else if (action === 'start') {
      state = {
        ...empty(),
        phase: 'ready',
        source: { sessionId: 'walkthrough-source' },
        status:
          'Starting point prepared. The brief, files, and conversation are ready to fork.',
      };
      render();
    } else if (action === 'fork') {
      state = {
        ...state,
        phase: 'comparing',
        branches: ['paper', 'midnight'].map((key) => ({
          key,
          html: renderPreview(key),
          sessionId: `walkthrough-${key}`,
        })),
        status:
          'Two independent directions. Pick a favorite; let the other go.',
      };
      render();
    } else if (action === 'choose') {
      state = {
        ...state,
        phase: 'chosen',
        winner: key,
        branches: state.branches.map((branch) =>
          branch.key === key
            ? branch
            : { ...branch, html: null, discarded: true },
        ),
        status:
          'One path kept. The other discarded. Your starting point is unchanged.',
      };
      render();
      $('result').scrollIntoView({ behavior: 'instant', block: 'nearest' });
    } else if (action === 'cleanup') {
      state = empty();
      render();
    }
  } catch (error) {
    state = { ...state, busy: false, error: error.message };
    render();
  }
}
$('start').onclick = () => act('start');
$('fork').onclick = () => act('fork');
$('reset').onclick = () => act('cleanup');
render();
if (live) {
  try {
    await refresh();
  } catch (error) {
    state.error = error.message;
    render();
  }
  setInterval(async () => {
    if (state.busy) {
      try {
        await refresh();
      } catch (error) {
        state = { ...state, busy: false, error: error.message };
        render();
      }
    }
  }, 1500);
}
