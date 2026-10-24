const moments = {
  welcome: 'Welcome', subscription: 'Connect ChatGPT', signin: 'Browser sign-in', prepare: 'Prepare workspace',
  installing: 'Download and boot', paused: 'Finish setup later', ready: 'Workspace ready', home: 'This computer',
  resources: 'Workspace settings', cloud: 'Connect AWS', transfer: 'Review copy', copying: 'Copy progress',
  copied: 'Cloud Session ready', recovery: 'Recovery',
};
const main = document.querySelector('#main');
const picker = document.querySelector('#moment');
for (const [value, label] of Object.entries(moments)) picker.add(new Option(label, value));
let limits = { cpus: 2, memory: 2, sessions: 2 };
let step = 0;
let issue = 'download';
let saved = false;
let signinReturn = 'prepare';
let destination = { endpoint: 'https://rat.example.com', region: 'us-west-2' };
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const button = (text, target, primary = false) => `<button ${primary ? 'class="primary"' : ''} data-go="${target}">${text}</button>`;
const row = (label, value, hint = '') => `<div class="row"><div>${label}${hint ? `<small>${hint}</small>` : ''}</div><div class="value">${value}</div></div>`;
const actions = (...items) => `<div class="actions">${items.join('')}</div>`;
const heading = (kicker, title, text) => `<div class="kicker">${kicker}</div><h1>${title}</h1><p class="lede">${text}</p>`;
const settings = () => `<div class="resource-grid"><label>CPU cores per Session<input name="cpus" type="number" min="1" max="8" value="${limits.cpus}" required></label><label>Memory per Session (GiB)<input name="memory" type="number" min="1" max="8" value="${limits.memory}" required></label><label>Simultaneous Sessions<input name="sessions" type="number" min="1" max="4" value="${limits.sessions}" required></label></div>`;
function screen(name) {
  switch (name) {
    case 'welcome': return `<div class="welcome"><img class="mark" src="/mark.svg" alt="">${heading('Your own workspace', 'A little help, right at home.', 'Give Rat Things a small job. It gets its own Linux workspace on this computer, with room to grow when you need it.')}<div class="cards"><div class="card selected"><h2>This computer</h2><p>Rat Things sets up the environment. Use your ChatGPT subscription. Your files stay here.</p></div><div class="card"><h2>Room to grow</h2><p>Copy a Session into your AWS account later, with the same tools and controls.</p></div></div>${actions(button('Set up this computer', 'subscription', true), button('Connect existing AWS', 'cloud'))}<p class="fine">Proposed first release: Apple silicon Macs. Cloud is optional.</p></div>`;
    case 'subscription': return `${heading('1 of 3 · Your account', 'Bring your ChatGPT subscription.', 'Sign in through your browser. Rat Things uses your plan for model access while work runs in your local environment.')}<div class="card wide"><h2>Codex with ChatGPT</h2><p>Your subscription’s usage limits apply. Account credentials stay on this computer and are not copied into workers or AWS.</p></div>${actions(button('Sign in with ChatGPT', 'signin', true), button('Back', 'welcome'))}<p class="fine">Local setup uses subscription sign-in. No API key is needed.</p>`;
    case 'signin': return `${heading(signinReturn === 'home' ? 'Reconnect your account' : '1 of 3 · Your account', 'Finish signing in in your browser.', 'Return here after connecting your ChatGPT account.')}<div class="card wide"><span class="status working">Waiting for browser sign-in</span><p>This review does not open a real login or access your account.</p></div>${actions(button('Simulate successful sign-in', signinReturn, true), button('Cancel sign-in', signinReturn === 'home' ? 'home' : 'subscription'))}`;
    case 'prepare': return `${heading('2 of 3 · Your computer', 'Make a little room.', 'Rat Things will download a verified Linux image and create an isolated workspace for each active Session.')}<form id="prepare-form">${settings()}<div class="rows">${row('Maximum active allocation', `<span id="allocation">${limits.cpus * limits.sessions} CPU cores · ${limits.memory * limits.sessions} GiB</span>`)}${row('Image download and disk space', 'Determined by release manifest', 'The shipped flow will show measured bytes and available storage.')}${row('Host folder access', 'None by default')}</div><p class="fine">This review uses example limits. Production limits need validation on your hardware.</p>${actions('<button class="primary" type="submit">Prepare workspace</button>', button('Back', 'subscription'))}</form>`;
    case 'installing': {
      const stages = ['Download Linux image', 'Verify image', 'Boot workspace'];
      return `${heading('2 of 3 · Setting up', stages[step], 'You can finish later. Setup will retain verified downloads and your existing Session disks.')}<div class="card wide">${stages.map((s, i) => `<div class="step ${i === step ? 'active' : ''}"><span class="number">${i < step ? '✓' : i + 1}</span><div>${s}<small>${i < step ? 'Complete' : i === step ? 'In progress · simulated' : 'Waiting'}</small></div></div>`).join('')}<progress aria-label="Setup progress" max="3" value="${step + .5}"></progress></div>${actions('<button class="primary" data-action="advance">Advance simulated step</button>', button('Finish later', 'paused'))}<div class="review-controls"><button data-issue="download">Preview download failure</button><button data-issue="disk">Preview insufficient space</button><button data-issue="boot">Preview boot failure</button></div>`;
    }
    case 'paused': return `${heading('Setup saved', 'Pick up here when you’re ready.', 'Your completed setup steps stay on this computer. Resume from the next unfinished step.')}<div class="card wide"><span class="status warning">Setup paused · simulated</span><p>Existing Session files remain available.</p></div>${actions(button('Resume setup', 'installing', true), button('Back to welcome', 'welcome'))}`;
    case 'ready': return `${heading('3 of 3 · Ready', 'Your workspace is ready.', 'Start small. Ask it to make something you can open and inspect.')}<div class="card wide"><h2>A first little job</h2><p>“Create a welcome.md file with three things you can help me with.”</p></div>${actions(button('Try this first job', 'home', true), button('Workspace settings', 'resources'))}<p class="fine">The prototype displays an example result; it does not run a model.</p>`;
    case 'home': return `${heading('This computer', 'A place for your projects.', 'Sessions keep their files and conversation here. Start another when you have something new in mind.')}<div class="rows">${row('Model access', 'ChatGPT subscription')}${row('Active Sessions', `1 of ${limits.sessions}`)}${row('Per Session', `${limits.cpus} CPU cores · ${limits.memory} GiB`)}</div><article class="card session"><header><h2>A first little job</h2><span class="status">Idle · example</span></header><p>Created welcome.md</p><pre class="file"># Hello from your Rat Things\n\nI can help organize a project, explore an idea,\nand make a useful little tool.</pre>${button('Continue this Session in AWS', 'cloud')}</article>${actions(button('Workspace settings', 'resources'))}<div class="review-controls"><button data-issue="subscription">Preview expired sign-in</button></div>`;
    case 'resources': return `${heading('Workspace settings', 'Leave room for the rest of your day.', 'Choose how much of this computer Rat Things may use. New limits apply the next time a worker starts.')}<form id="settings-form">${settings()}<p class="fine">CPU and memory are per active Session. Session disks survive stopping a worker.</p><div id="saved" class="status" ${saved ? '' : 'hidden'}>Saved for this review</div>${actions('<button class="primary" type="submit">Save limits</button>', button('Back to Sessions', 'home'))}</form>`;
    case 'cloud': return `${heading('Room to grow · Your AWS account', 'Bring this Session along.', 'Connect an existing Rat Things deployment, then review exactly what will be copied. The local Session stays here.')}<div class="card wide"><h2>Connect an existing deployment</h2><form id="cloud-form"><label class="field">Rat Things API endpoint<input type="url" name="endpoint" value="${escape(destination.endpoint)}" required></label><label class="field">AWS region<input name="region" pattern="[a-z]{2}(-[a-z]+)+-[0-9]+" value="${escape(destination.region)}" required></label><p class="fine">Example connection only. The shipped flow validates your AWS identity and destination capabilities.</p><button class="primary">Review Session copy</button></form></div><div class="card"><h2>Need a deployment?</h2><p>The planned setup flow will prepare a Terraform plan for your AWS account, show the resources and cost considerations, and ask before applying it.</p><p class="fine">Deployment setup is not interactive in this review.</p></div>${actions(button('Back to this computer', 'home'))}`;
    case 'transfer': return `${heading('Review copy', 'A familiar Session, with more room.', 'This example Session is idle and ready to copy. Nothing starts running in AWS until you send a new message.')}<div class="rows">${row('Destination', `${escape(destination.endpoint)}<small>${escape(destination.region)}</small>`)}${row('Copy', 'Workspace files, history, Agent configuration')}${row('Model and capabilities', 'Must match a supported destination', 'The real plan blocks unsupported differences before copying.')}${row('Keep on this computer', 'Original Session and files')}${row('Credentials', 'Connect separately in AWS')}</div><div class="note">AWS compute and model access are billed according to your cloud configuration. Your local ChatGPT sign-in is not transferred.</div>${actions(button('Copy Session to AWS', 'copying', true), button('Back', 'cloud'))}`;
    case 'copying': return `${heading('Copying Session · Simulated', 'Packing the useful things.', 'The transfer keeps its identity so a retry can continue the same copy. Your local original remains available.')}<div class="card wide"><div class="step"><span class="number">✓</span><div>Snapshot idle Session<small>Complete</small></div></div><div class="step active"><span class="number">2</span><div>Copy files and history<small>In progress · simulated</small></div></div><div class="step"><span class="number">3</span><div>Verify destination<small>Waiting</small></div></div></div>${actions(button('Simulate completed copy', 'copied', true), button('View local Session', 'home'))}<div class="review-controls"><button data-issue="copy">Preview interrupted copy</button></div>`;
    case 'copied': return `${heading('Cloud Session ready', 'Settled in. Waiting for you.', 'The copied Session is idle in your AWS account. Open it and send a message when you’re ready to continue.')}<div class="rows">${row('AWS Session', 'Idle · example')}${row('Local original', 'Retained')}${row('History and files', 'Copied · example')}</div>${actions(button('Review copy again', 'transfer', true), button('Return to local Session', 'home'))}<p class="fine">Opening the actual cloud Session will use the existing Rat Things console. This prototype has no live destination.</p>`;
    case 'recovery': {
      const problems = {
        download: ['The download was interrupted.', 'Verified data can be reused. Retry the download when your connection is back.', 'Resume download', 'installing'],
        disk: ['This computer needs more free space.', 'Setup will show the required and available bytes before continuing. Your existing Session disks will be retained.', 'Check space again', 'prepare'],
        boot: ['The workspace did not start.', 'Restart the worker using the same Session disk. If this follows an image update, recovery should offer the last verified image.', 'Retry workspace boot', 'installing'],
        subscription: ['Connect ChatGPT again.', 'Your Session and files are still here. Sign in to restore model access.', 'Sign in with ChatGPT', 'signin'],
        copy: ['The copy was interrupted.', 'Retry this transfer. The existing transfer identity prevents creating another destination Session.', 'Retry this copy', 'copying'],
      };
      const [title, text, label, target] = problems[issue];
      return `${heading('Recovery · Simulated', title, text)}<div class="card wide"><span class="status warning">Action needed</span><p>Recovery must preserve the original workspace and explain the next action.</p></div>${actions(button(label, target, true), button('Return to local Session', 'home'))}`;
    }
  }
}
function render() {
  const name = location.hash.slice(1) || 'welcome';
  const current = Object.hasOwn(moments, name) ? name : 'welcome';
  picker.value = current;
  main.innerHTML = `<div class="crumb">This computer / ${moments[current]}</div><div class="content">${screen(current)}</div>`;
  document.querySelectorAll('nav button').forEach(el => el.setAttribute('aria-current', el.dataset.go === current ? 'page' : 'false'));
  main.focus({ preventScroll: true });
}
document.addEventListener('click', event => {
  const target = event.target.closest('button');
  if (!target) return;
  if (target.dataset.go) {
    event.preventDefault();
    if (target.dataset.go === 'signin') signinReturn = location.hash === '#recovery' && issue === 'subscription' ? 'home' : 'prepare';
    location.hash = target.dataset.go;
  }
  if (target.dataset.issue) {
    issue = target.dataset.issue;
    if (issue === 'boot') step = 2;
    if (issue === 'download') step = 0;
    location.hash = 'recovery'; render();
  }
  if (target.dataset.action === 'advance') { if (step < 2) { step++; render(); } else location.hash = 'ready'; }
});
document.addEventListener('submit', event => {
  event.preventDefault();
  const form = event.target;
  if (!form.reportValidity()) return;
  if (form.id === 'cloud-form') {
    const values = Object.fromEntries(new FormData(form));
    const endpoint = new URL(values.endpoint);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) {
      form.elements.endpoint.setCustomValidity('Use an HTTPS endpoint without credentials.'); form.reportValidity(); return;
    }
    destination = { endpoint: endpoint.href.replace(/\/$/, ''), region: values.region };
    location.hash = 'transfer'; return;
  }
  const values = Object.fromEntries(new FormData(form));
  limits = { cpus: Number(values.cpus), memory: Number(values.memory), sessions: Number(values.sessions) };
  saved = true;
  if (form.id === 'prepare-form') { step = 0; location.hash = 'installing'; } else render();
});
document.addEventListener('input', event => {
  event.target.setCustomValidity?.('');
  const form = event.target.closest('#prepare-form');
  if (!form) return;
  const values = Object.fromEntries(new FormData(form));
  const allocation = document.querySelector('#allocation');
  allocation.textContent = `${Number(values.cpus) * Number(values.sessions)} CPU cores · ${Number(values.memory) * Number(values.sessions)} GiB`;
});
picker.addEventListener('change', () => { location.hash = picker.value; });
window.addEventListener('hashchange', render);
render();
