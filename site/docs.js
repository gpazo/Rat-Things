const filters = [...document.querySelectorAll('[data-docs-filter]')];
for (const filter of filters) {
  filter.addEventListener('input', () => filterDocumentation(filter.value));
}

function filterDocumentation(value) {
  const query = value.trim().toLowerCase();
  let anyMatch = false;
  for (const filter of filters) {
    if (filter.value !== value) filter.value = value;
  }
  for (const group of document.querySelectorAll('[data-doc-group]')) {
    let visibleLinks = 0;
    for (const link of group.querySelectorAll('[data-doc-link]')) {
      const visible = !query || link.textContent.toLowerCase().includes(query);
      link.hidden = !visible;
      if (visible) visibleLinks += 1;
    }
    group.hidden = visibleLinks === 0;
    anyMatch ||= visibleLinks > 0;
  }
  for (const status of document.querySelectorAll('[data-docs-filter-status]')) {
    status.hidden = !query || anyMatch;
    status.textContent = !query || anyMatch ? '' : `No guides match “${value.trim()}”.`;
  }
}

for (const block of document.querySelectorAll('.doc-article pre')) {
  const code = block.querySelector('code');
  if (!code) continue;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'copy-code';
  button.textContent = 'Copy';
  button.setAttribute('aria-label', 'Copy code block');
  button.addEventListener('click', async () => {
    try {
      await copyText(code.textContent);
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Copy unavailable';
    }
    window.setTimeout(() => { button.textContent = 'Copy'; }, 1_500);
  });
  block.append(button);
}

async function copyText(value) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    // Fall through to a local selection-based copy for restricted browser contexts.
  }
  const input = document.createElement('textarea');
  input.value = value;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.append(input);
  input.select();
  const copied = document.execCommand('copy');
  input.remove();
  if (!copied) throw new Error('copy unavailable');
}
