const filter = document.querySelector('[data-docs-filter]');
if (filter) {
  filter.addEventListener('input', () => {
    const query = filter.value.trim().toLowerCase();
    for (const group of document.querySelectorAll('[data-doc-group]')) {
      let visibleLinks = 0;
      for (const link of group.querySelectorAll('[data-doc-link]')) {
        const visible = !query || link.textContent.toLowerCase().includes(query);
        link.hidden = !visible;
        if (visible) visibleLinks += 1;
      }
      group.hidden = visibleLinks === 0;
    }
  });
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
    await navigator.clipboard.writeText(code.textContent);
    button.textContent = 'Copied';
    window.setTimeout(() => { button.textContent = 'Copy'; }, 1_500);
  });
  block.append(button);
}
