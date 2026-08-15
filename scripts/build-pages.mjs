import { access, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join, posix, relative } from 'node:path';
import { marked } from 'marked';

const output = 'dist-pages';
const docsOutput = join(output, 'docs');
const repositoryUrl = 'https://github.com/gpazo/Rat-Things';
const pagesUrl = 'https://gpazo.github.io/Rat-Things';
const docsConfig = JSON.parse(await readFile('site/docs.json', 'utf8'));

marked.setOptions({ gfm: true });

await rm(output, { recursive: true, force: true });
await cp('site', output, { recursive: true });
await mkdir(join(output, 'assets', 'architecture'), { recursive: true });
await cp('assets/rat-things-hero.jpg', join(output, 'assets', 'rat-things-hero.jpg'));
await cp('assets/rat-things-og-v2.jpg', join(output, 'assets', 'rat-things-og-v2.jpg'));
await writeFile(join(output, '.nojekyll'), '');

const docsEntries = await readdir('docs', { withFileTypes: true });
const markdownFiles = docsEntries
  .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
  .map((entry) => entry.name)
  .sort();
const docs = new Map();
for (const file of markdownFiles) {
  const source = await readFile(join('docs', file), 'utf8');
  docs.set(file, documentMetadata(file, source));
}

const configuredFiles = new Set(docsConfig.groups.flatMap((group) => group.documents));
const unconfiguredFiles = markdownFiles.filter((file) => !configuredFiles.has(file));
const groups = [
  ...docsConfig.groups,
  ...(unconfiguredFiles.length > 0 ? [{ title: 'More', documents: unconfiguredFiles }] : []),
];
validateDocumentationConfig(groups, docs);

await mkdir(docsOutput, { recursive: true });
await copyDocumentationAssets(docsEntries);
await writeFile(join(docsOutput, 'index.html'), renderDocsHome(groups, docs));

const orderedDocs = groups.flatMap((group) => group.documents.map((file) => docs.get(file)));
const generatedHtmlFiles = [join(output, 'index.html'), join(docsOutput, 'index.html')];
for (const [index, doc] of orderedDocs.entries()) {
  const pageDirectory = join(docsOutput, doc.slug);
  await mkdir(pageDirectory, { recursive: true });
  const pageFile = join(pageDirectory, 'index.html');
  await writeFile(pageFile, renderDocumentPage({
    doc,
    groups,
    docs,
    previous: orderedDocs[index - 1],
    next: orderedDocs[index + 1],
  }));
  generatedHtmlFiles.push(pageFile);
}

await writeFile(join(output, 'sitemap.xml'), renderSitemap(orderedDocs));
await validateGeneratedLinks(generatedHtmlFiles);
process.stdout.write(`built ${output} with ${orderedDocs.length} documentation pages\n`);

function documentMetadata(file, source) {
  const title = source.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? basename(file, '.md');
  const slug = basename(file, '.md');
  const description = extractDescription(source);
  const rendered = addHeadingIds(rewriteDocumentLinks(marked.parse(source), file));
  const tableOfContents = extractTableOfContents(rendered);
  return { file, slug, title, description, rendered, tableOfContents };
}

function extractDescription(source) {
  const withoutCode = source.replace(/```[\s\S]*?```/g, '');
  const blocks = withoutCode.split(/\n\s*\n/).map((block) => block.trim());
  const paragraph = blocks.find((block) => (
    block &&
    !block.startsWith('#') &&
    !block.startsWith('|') &&
    !block.startsWith('- ') &&
    !block.startsWith('* ') &&
    !block.startsWith('>') &&
    !/^\d+\.\s/.test(block)
  ));
  return truncate(plainMarkdown(paragraph ?? 'Rat Things documentation.'), 180);
}

function rewriteDocumentLinks(html, file) {
  return html
    .replace(/href="([^"]+)"/g, (_, href) => `href="${escapeHtml(rewriteHref(href, file))}"`)
    .replace(/src="([^"]+)"/g, (_, source) => `src="${escapeHtml(rewriteAsset(source))}"`);
}

function rewriteHref(href, file) {
  if (isExternalReference(href) || href.startsWith('#')) return href;
  const [path, fragment] = href.split('#', 2);
  if (path.endsWith('.md') && !path.startsWith('../')) {
    return `../${basename(path, '.md')}/${fragment ? `#${fragment}` : ''}`;
  }
  if (path.startsWith('../')) {
    const repositoryPath = posix.normalize(posix.join('docs', path));
    return `${repositoryUrl}/blob/main/${repositoryPath}${fragment ? `#${fragment}` : ''}`;
  }
  if (['.png', '.svg', '.mmd'].includes(extname(path))) {
    return `../assets/${basename(path)}${fragment ? `#${fragment}` : ''}`;
  }
  throw new Error(`unsupported local documentation link ${href} in ${file}`);
}

function rewriteAsset(source) {
  if (isExternalReference(source) || source.startsWith('data:')) return source;
  return `../assets/${basename(source)}`;
}

function addHeadingIds(html) {
  const counts = new Map();
  return html.replace(/<h([1-3])>([\s\S]*?)<\/h\1>/g, (_, level, content) => {
    const base = slugify(stripHtml(content)) || 'section';
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    const id = count === 0 ? base : `${base}-${count + 1}`;
    return `<h${level} id="${id}">${content}<a class="heading-anchor" href="#${id}" aria-label="Link to ${escapeHtml(stripHtml(content))}">#</a></h${level}>`;
  });
}

function extractTableOfContents(html) {
  return [...html.matchAll(/<h([2-3]) id="([^"]+)">([\s\S]*?)<a class="heading-anchor"/g)]
    .map((match) => ({ level: Number(match[1]), id: match[2], title: stripHtml(match[3]) }));
}

async function copyDocumentationAssets(entries) {
  const assetsDirectory = join(docsOutput, 'assets');
  await mkdir(assetsDirectory, { recursive: true });
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.endsWith('.md')) continue;
    await cp(join('docs', entry.name), join(assetsDirectory, entry.name));
    if (entry.name.endsWith('.png')) {
      await cp(join('docs', entry.name), join(output, 'assets', 'architecture', entry.name));
    }
  }
}

function validateDocumentationConfig(groups, documents) {
  const seen = new Set();
  for (const group of groups) {
    if (!group.title || group.documents.length === 0) throw new Error('documentation groups need a title and documents');
    for (const file of group.documents) {
      if (!documents.has(file)) throw new Error(`documentation page ${file} does not exist`);
      if (seen.has(file)) throw new Error(`documentation page ${file} appears in more than one group`);
      seen.add(file);
    }
  }
}

function renderDocsHome(groups, documents) {
  const nav = renderDocumentationNav(groups, documents, undefined, './');
  const cards = groups.map((group) => `
    <section class="docs-card-group" aria-labelledby="${slugify(group.title)}-title">
      <p class="docs-card-kicker">${escapeHtml(group.title)}</p>
      <div class="docs-card-grid">
        ${group.documents.map((file) => {
          const doc = documents.get(file);
          return `<a class="docs-card" data-doc-card href="./${doc.slug}/">
            <span>${escapeHtml(doc.title)}</span>
            <small>${escapeHtml(doc.description)}</small>
          </a>`;
        }).join('\n')}
      </div>
    </section>`).join('\n');
  return pageTemplate({
    title: 'Documentation',
    description: 'Practical Rat Things guides for people and agents: start, connect services, publish work, deploy, operate, and troubleshoot.',
    canonicalPath: '/docs/',
    assetPrefix: '../',
    nav,
    main: `
      <div class="docs-home">
        <p class="docs-eyebrow">Documentation for people and agents</p>
        <h1>Use the runtime.<br>Miss fewer sharp edges.</h1>
        <p class="docs-home-lede">Start with the workflow you need. Every guide is published from the repository Markdown, so the website and the instructions agents read stay together.</p>
        <div class="docs-home-actions">
          <a class="docs-button docs-button-primary" href="./codex-subscription/">Run locally</a>
          <a class="docs-button" href="./sharing-work/">Share agent work</a>
          <a class="docs-button" href="./development-and-deployment/">Deploy to AWS</a>
        </div>
        <section class="sharp-edges" aria-labelledby="sharp-edges-title">
          <div>
            <p class="docs-card-kicker">Start with what surprised us</p>
            <h2 id="sharp-edges-title">Known sharp edges</h2>
          </div>
          <ul>
            <li><strong>Share the whole grant URL.</strong><span>The bare publication hostname is not a reusable link; keep the <code>/__share/…</code> path.</span></li>
            <li><strong>Expiry is not deletion.</strong><span>A link can expire while the retained file remains available to its owner for a fresh link.</span></li>
            <li><strong>Sites are deliberately constrained.</strong><span>Use relative local assets. External scripts and surprise network calls are blocked by the publication policy.</span></li>
            <li><strong>Remote authentication is separate.</strong><span>A headless MicroVM cannot inherit the ChatGPT login from your laptop.</span></li>
          </ul>
        </section>
        ${cards}
        <aside class="agent-source">
          <div>
            <p class="docs-card-kicker">For coding agents</p>
            <h2>Prefer the source instructions?</h2>
            <p>Every page links to its raw Markdown. Point an agent at the relevant guide, then ask it to follow the validation and pitfall sections exactly.</p>
          </div>
          <a class="docs-button" href="${repositoryUrl}/tree/main/docs">Browse Markdown on GitHub</a>
        </aside>
      </div>`,
  });
}

function renderDocumentPage({ doc, groups, docs, previous, next }) {
  const nav = renderDocumentationNav(groups, docs, doc.file, '../');
  const toc = doc.tableOfContents.length === 0 ? '' : `
    <aside class="docs-toc" aria-label="On this page">
      <p>On this page</p>
      ${doc.tableOfContents.map((item) => `<a class="toc-level-${item.level}" href="#${item.id}">${escapeHtml(item.title)}</a>`).join('\n')}
    </aside>`;
  const previousLink = previous
    ? `<a class="page-step page-step-previous" href="../${previous.slug}/"><small>Previous</small><span>${escapeHtml(previous.title)}</span></a>`
    : '<span></span>';
  const nextLink = next
    ? `<a class="page-step page-step-next" href="../${next.slug}/"><small>Next</small><span>${escapeHtml(next.title)}</span></a>`
    : '<span></span>';
  return pageTemplate({
    title: doc.title,
    description: doc.description,
    canonicalPath: `/docs/${doc.slug}/`,
    assetPrefix: '../../',
    nav,
    toc,
    main: `
      <div class="doc-toolbar">
        <a href="../">Documentation</a><span>/</span><span>${escapeHtml(doc.title)}</span>
        <div>
          <a href="https://raw.githubusercontent.com/gpazo/Rat-Things/main/docs/${doc.file}">Raw Markdown</a>
          <a href="${repositoryUrl}/edit/main/docs/${doc.file}">Edit this page</a>
        </div>
      </div>
      <article class="doc-article">${doc.rendered}</article>
      <nav class="page-steps" aria-label="Documentation pagination">${previousLink}${nextLink}</nav>`,
  });
}

function pageTemplate({ title, description, canonicalPath, assetPrefix, nav, main, toc = '' }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)} — Rat Things documentation</title>
    <meta name="description" content="${escapeHtml(description)}">
    <meta name="theme-color" content="#071116">
    <meta property="og:type" content="website">
    <meta property="og:title" content="${escapeHtml(title)} — Rat Things documentation">
    <meta property="og:description" content="${escapeHtml(description)}">
    <meta property="og:url" content="${pagesUrl}${canonicalPath}">
    <meta property="og:image" content="${pagesUrl}/assets/rat-things-og-v2.jpg">
    <meta name="twitter:card" content="summary_large_image">
    <link rel="canonical" href="${pagesUrl}${canonicalPath}">
    <link rel="stylesheet" href="${assetPrefix}docs.css?v=1">
    <script defer src="${assetPrefix}docs.js?v=1"></script>
  </head>
  <body class="docs-body">
    <a class="docs-skip-link" href="#docs-main">Skip to documentation</a>
    <header class="docs-topbar">
      <a class="docs-brand" href="${assetPrefix}" aria-label="Rat Things home"><span aria-hidden="true"></span>Rat Things</a>
      <nav aria-label="Documentation header">
        <a href="${assetPrefix}docs/">Docs</a>
        <a href="${repositoryUrl}">GitHub</a>
      </nav>
    </header>
    <div class="docs-shell">
      <aside class="docs-sidebar">
        <label for="docs-filter">Find a guide</label>
        <input id="docs-filter" data-docs-filter type="search" placeholder="Filter documentation">
        ${nav}
      </aside>
      <main id="docs-main" class="docs-main">
        <details class="docs-mobile-nav"><summary>Browse documentation</summary>${nav}</details>
        ${main}
      </main>
      ${toc}
    </div>
    <footer class="docs-footer"><span>Rat Things is an engineering preview.</span><a href="${repositoryUrl}/issues">Report a documentation issue</a></footer>
  </body>
</html>`;
}

function renderDocumentationNav(groups, documents, currentFile, prefix) {
  return `<nav class="documentation-nav" aria-label="Documentation navigation">
    ${groups.map((group) => `<section data-doc-group>
      <h2>${escapeHtml(group.title)}</h2>
      ${group.documents.map((file) => {
        const doc = documents.get(file);
        const current = file === currentFile ? ' aria-current="page"' : '';
        return `<a data-doc-link href="${prefix}${doc.slug}/"${current}>${escapeHtml(doc.title)}</a>`;
      }).join('\n')}
    </section>`).join('\n')}
  </nav>`;
}

function renderSitemap(documents) {
  const urls = ['/', '/docs/', ...documents.map((doc) => `/docs/${doc.slug}/`)];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((path) => `  <url><loc>${pagesUrl}${path}</loc></url>`).join('\n')}
</urlset>\n`;
}

async function validateGeneratedLinks(htmlFiles) {
  for (const htmlFile of htmlFiles) {
    const html = await readFile(htmlFile, 'utf8');
    const pagePath = `/${relative(output, htmlFile).split('\\').join('/')}`;
    for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const reference = match[1];
      if (isExternalReference(reference) || reference.startsWith('#')) continue;
      const targetUrl = new URL(reference, `https://pages.invalid${pagePath}`);
      let targetPath = decodeURIComponent(targetUrl.pathname).replace(/^\//, '');
      if (targetPath.endsWith('/')) targetPath += 'index.html';
      try {
        await access(join(output, targetPath));
      } catch {
        throw new Error(`generated link ${reference} in ${htmlFile} does not resolve`);
      }
    }
  }
}

function plainMarkdown(value) {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*_>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripHtml(value) {
  return value.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function truncate(value, length) {
  return value.length <= length ? value : `${value.slice(0, length - 1).trimEnd()}…`;
}

function isExternalReference(value) {
  return /^(?:[a-z]+:|\/\/)/i.test(value);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
