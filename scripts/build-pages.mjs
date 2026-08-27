import { access, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join, posix, relative } from 'node:path';
import { marked } from 'marked';

const output = 'dist-pages';
const docsOutput = join(output, 'docs');
const repositoryUrl = 'https://github.com/gpazo/Rat-Things';
const pagesUrl = 'https://gpazo.github.io/Rat-Things';
const docsConfig = JSON.parse(await readFile('site/docs.json', 'utf8'));
const visualAssetFiles = [
  'product-overview.svg',
  'thing-lifecycle.svg',
  'permission-intersection.svg',
  'durable-execution.svg',
];
const homepageAssetFiles = [
  'rat-things-hero.jpg',
  'rat-things-og-v2.jpg',
  'conversation-console-desktop.png',
  'conversation-console-artifact-viewer.png',
  'conversation-console-mobile-input.png',
  'conversation-console-live-browser.png',
  'conversation-console-live-activity.png',
  'conversation-console-mobile-browser.png',
  'cli-live-aws-attachment-reply.jpg',
];
const documentationSharedAssetFiles = [
  'conversation-console-live-browser.png',
  'conversation-console-live-activity.png',
  'cli-live-aws-attachment-reply.jpg',
  'cli-live-aws-conversation.jpg',
];

marked.setOptions({ gfm: true });

await rm(output, { recursive: true, force: true });
await cp('site', output, { recursive: true });
await normalizeCopiedSitePaths();
await cp('spec/openapi.json', join(output, 'openapi.json'));
await cp('spec/schemas', join(output, 'schemas'), { recursive: true });
await cp('examples', join(output, 'examples'), { recursive: true });
await mkdir(join(output, 'assets', 'architecture'), { recursive: true });
await mkdir(join(output, 'assets', 'visuals'), { recursive: true });
for (const file of homepageAssetFiles) {
  await cp(join('assets', file), join(output, 'assets', file));
}
await writeFile(join(output, '.nojekyll'), '');

const docsEntries = await readdir('docs', { withFileTypes: true });
await validateVisualAssets();
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
const archivedFiles = new Set(docsConfig.archive ?? []);
const unconfiguredFiles = markdownFiles.filter((file) => !configuredFiles.has(file));
const unexpectedlyUnconfigured = unconfiguredFiles.filter((file) => !archivedFiles.has(file));
if (unexpectedlyUnconfigured.length > 0) {
  throw new Error(`documentation files must be explicitly published or archived: ${unexpectedlyUnconfigured.join(', ')}`);
}
const groups = docsConfig.groups;
validateDocumentationConfig(groups, archivedFiles, docs);

await mkdir(docsOutput, { recursive: true });
await copyDocumentationAssets(docsEntries);
for (const file of documentationSharedAssetFiles) {
  await cp(join('assets', file), join(docsOutput, 'assets', file));
}
await writeFile(join(docsOutput, 'index.html'), renderDocsHome(groups, docs));

const orderedDocs = groups.flatMap((group) => group.documents.map((file) => docs.get(file)));
const agentCorpusExclude = new Set(docsConfig.agentCorpusExclude ?? []);
const agentGroups = groups
  .map((group) => ({
    ...group,
    documents: group.documents.filter((file) => !agentCorpusExclude.has(file)),
  }))
  .filter((group) => group.documents.length > 0);
const agentDocs = orderedDocs.filter((doc) => !agentCorpusExclude.has(doc.file));
await writeFile(join(output, 'llms.txt'), addCapabilityBoundaryInstruction(renderLlmsIndex(agentGroups, docs)));
await writeFile(join(output, 'llms-full.txt'), renderLlmsFull(agentDocs));
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

async function normalizeCopiedSitePaths() {
  const homepagePath = join(output, 'index.html');
  const homepage = (await readFile(homepagePath, 'utf8'))
    .replaceAll('../assets/', 'assets/')
    .replaceAll('../docs/product-overview.svg', 'assets/visuals/product-overview.svg');
  await writeFile(homepagePath, homepage);

  const stylesheetPath = join(output, 'styles.css');
  const stylesheet = (await readFile(stylesheetPath, 'utf8'))
    .replaceAll('../assets/', 'assets/');
  await writeFile(stylesheetPath, stylesheet);
}

function documentMetadata(file, source) {
  const title = source.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? basename(file, '.md');
  const slug = basename(file, '.md');
  const description = docsConfig.descriptions?.[file] ?? extractDescription(source);
  const rendered = addHeadingIds(wrapTables(rewriteDocumentLinks(marked.parse(source), file)));
  const tableOfContents = extractTableOfContents(rendered);
  return { file, slug, title, description, source, rendered, tableOfContents };
}

function wrapTables(html) {
  return html
    .replaceAll('<table>', '<div class="table-scroll" role="region" aria-label="Scrollable table" tabindex="0"><table>')
    .replaceAll('</table>', '</table></div>');
}

function renderLlmsIndex(groups, documents) {
  const sections = groups.map((group) => `## ${group.title}\n\n${group.documents.map((file) => {
    const document = documents.get(file);
    return `- [${document.title}](${pagesUrl}/docs/${document.slug}/): ${document.description}`;
  }).join('\n')}`).join('\n\n');
  return `# Rat Things\n\n> The open-source, self-hostable backend for cloud agents, with isolated Codex execution, reusable Things, multi-account integrations, browser use, and durable work. Rat Things is an engineering preview, not a production-ready multi-tenant service.\n\n## Agent quickstart\n\nA host gives you a Rat Things deployment base URL and an authenticated calling method.\n\n1. Fetch \`/.well-known/rat-things\` from that deployment. Resolve its relative links against the deployment URL.\n2. Treat the installed OpenAPI, JSON Schemas, capability profiles, and integration manifests as authoritative.\n3. Prefer Things for reusable work: create a draft, explain it, test it, publish the exact immutable revision, then run or schedule the active revision. Start with explicit read-only/no-network capabilities and widen only for the task.\n4. Every accepted execution returns one Run. Retain its Run ID and follow its \`Location\`, durable state, or live events; optional \`thread\` continuity does not create another public receipt.\n5. Use raw runs, thread continuity, browser use, skills, apps, MCP, publications, and provider-event ingress only when the task needs those deeper surfaces.\n6. Never submit an owner ID or place AWS, provider, S3, or MicroVM credentials in a Thing or run.\n\nRead [Connect an agent to Rat Things](${pagesUrl}/docs/agents/) for authentication options, the smallest complete journey, the deeper capability map, failure rules, and a copyable bootstrap instruction. Do not load the full corpus for a simple Thing run.\n\n${sections}\n\n## Machine-readable contracts\n\nString lengths in JSON Schema are preflight character limits; runtime UTF-8 byte limits remain authoritative.\n\n- [OpenAPI 3.1](${pagesUrl}/openapi.json): Published reference contract; an installed deployment's linked copy is authoritative.\n- [ThingSpec v1 JSON Schema](${pagesUrl}/schemas/thing-v1.json): Portable credential-free automation definition.\n- [Create Thing schema](${pagesUrl}/schemas/thing-create-v1.json): Direct draft-only Thing creation contract.\n- [Create Thing version schema](${pagesUrl}/schemas/thing-version-v1.json): Compare-and-swap draft revision contract.\n- [Operational agent corpus](${pagesUrl}/llms-full.txt): Published agent documentation combined into one document; load only when broad context is necessary.\n\n## Source and examples\n\n- [Repository](${repositoryUrl})\n- [Safe first-run ThingSpec](${pagesUrl}/examples/thing-create.json)\n- [Connected scheduled ThingSpec](${pagesUrl}/examples/thing-connected-schedule.json)\n- [Updated ThingSpec example for the CLI or nested version request](${pagesUrl}/examples/thing-version.json)\n`;
}

function renderLlmsFull(documents) {
  return `# Rat Things operational agent documentation\n\nSource: ${repositoryUrl}\nCanonical index: ${pagesUrl}/llms.txt\n\n${documents.map((document) => (
    `---\n\n<!-- ${document.file} -->\n\n${document.source.trim()}\n`
  )).join('\n')}\n`;
}

function addCapabilityBoundaryInstruction(source) {
  return source
    .replace(
      '\n5. Use raw runs,',
      '\n5. Rat Things has no mid-Run approval flow. Inside the fixed pre-launch capability envelope, execution is autonomous. Outside it, a tool is absent or the enforcing layer denies the operation; report that boundary instead of waiting for permission or searching for another identity, credential, path, or route.\n6. Use raw runs,',
    )
    .replace(
      '\n6. Never submit an owner ID',
      '\n7. Never submit an owner ID',
    );
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
  if (['.json', '.png', '.svg', '.mmd'].includes(extname(path))) {
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
    if (visualAssetFiles.includes(entry.name)) {
      await cp(join('docs', entry.name), join(output, 'assets', 'visuals', entry.name));
    }
  }
}

async function validateVisualAssets() {
  for (const file of visualAssetFiles) {
    const source = await readFile(join('docs', file), 'utf8');
    const primaryNodes = [...source.matchAll(/data-node="primary"/g)].length;
    const required = [
      '<svg',
      'viewBox=',
      'role="img"',
      'aria-labelledby=',
      'data-visual-question=',
      '<title id=',
      '<desc id=',
    ];
    for (const token of required) {
      if (!source.includes(token)) throw new Error(`visual ${file} is missing ${token}`);
    }
    if (primaryNodes < 3 || primaryNodes > 5) {
      throw new Error(`visual ${file} must contain three to five primary nodes; found ${primaryNodes}`);
    }
    if (/<(?:script|foreignObject|image)\b/i.test(source)) {
      throw new Error(`visual ${file} must remain text-native and script-free`);
    }
  }
}

function validateDocumentationConfig(groups, archivedFiles, documents) {
  const seen = new Set();
  for (const group of groups) {
    if (!group.title || group.documents.length === 0) throw new Error('documentation groups need a title and documents');
    for (const file of group.documents) {
      if (!documents.has(file)) throw new Error(`documentation page ${file} does not exist`);
      if (seen.has(file)) throw new Error(`documentation page ${file} appears in more than one group`);
      seen.add(file);
    }
  }
  for (const file of archivedFiles) {
    if (!documents.has(file)) throw new Error(`archived documentation page ${file} does not exist`);
    if (seen.has(file)) throw new Error(`documentation page ${file} cannot be both published and archived`);
  }
}

function renderDocsHome(groups, documents) {
  const nav = renderDocumentationNav(groups, documents, undefined, './');
  const cards = groups.slice(1).map((group) => `
    <section class="docs-card-group" data-doc-group aria-labelledby="${slugify(group.title)}-title">
      <p class="docs-card-kicker">${escapeHtml(group.title)}</p>
      <div class="docs-card-grid">
        ${group.documents.map((file) => {
          const doc = documents.get(file);
          return `<a class="docs-card" data-doc-card data-doc-link href="./${doc.slug}/">
            <span>${escapeHtml(doc.title)}</span>
            <small>${escapeHtml(doc.description)}</small>
          </a>`;
        }).join('\n')}
      </div>
    </section>`).join('\n');
  return pageTemplate({
    title: 'Documentation',
    description: 'Build and embed reusable cloud agents through a self-hosted OpenAPI backend with isolated Codex execution.',
    canonicalPath: '/docs/',
    assetPrefix: '../',
    nav,
    main: `
      <div class="docs-home">
        <p class="docs-eyebrow">Rat Things documentation</p>
        <h1>Choose the path<br>you need.</h1>
        <p class="docs-home-lede">Start with a product overview, deploy to AWS, connect an agent to an existing deployment, or embed the API. Deeper operator and agent reference stays available when the task needs it.</p>
        <section class="docs-paths" data-doc-group aria-labelledby="docs-paths-title">
          <h2 id="docs-paths-title" class="docs-sr-only">Choose a documentation path</h2>
          <a data-doc-link href="./codex-subscription/"><span>Try it locally</span><small>Use a trusted ChatGPT sign-in on your own device.</small></a>
          <a data-doc-link href="./quickstart/"><span>Deploy the backend</span><small>Run the bounded AWS golden path and retain evidence.</small></a>
          <a data-doc-link href="./agents/"><span>Connect an agent</span><small>Discover an installed deployment from one URL.</small></a>
          <a data-doc-link href="./embedding/"><span>Embed Rat Things</span><small>Put the owner-scoped API behind your own product UX.</small></a>
        </section>
        ${cards}
        <aside class="agent-source">
          <div>
            <p class="docs-card-kicker">For coding agents</p>
            <h2>Give an agent one URL.</h2>
            <p>The agent guide tells an agent to discover the installed deployment, use Things first, and open live controls, conversations, raw runs, browser use, skills, apps, MCP, files, and publications only as needed.</p>
          </div>
          <div class="docs-home-actions">
            <a class="docs-button docs-button-primary" href="./agents/">Agent quickstart</a>
            <a class="docs-button" href="../llms.txt">llms.txt</a>
          </div>
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
        <div class="doc-breadcrumb"><a href="../">Documentation</a><span>/</span><span>${escapeHtml(doc.title)}</span></div>
        <div class="doc-toolbar-actions">
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
    <link rel="stylesheet" href="${assetPrefix}docs.css?v=2">
    <script defer src="${assetPrefix}docs.js?v=2"></script>
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
        ${renderDocumentationFilter('docs-filter')}
        ${nav}
      </aside>
      <main id="docs-main" class="docs-main">
        <div class="docs-mobile-filter">${renderDocumentationFilter('docs-mobile-filter')}</div>
        <details class="docs-mobile-nav"><summary>Browse documentation</summary>${nav}</details>
        ${main}
      </main>
      ${toc}
    </div>
    <footer class="docs-footer"><span>Durable Codex work, isolated execution, and browser-ready publications.</span><a href="${repositoryUrl}/issues">Help improve the docs</a></footer>
  </body>
</html>`;
}

function renderDocumentationFilter(id) {
  return `<div class="docs-filter">
    <label for="${id}">Find a guide</label>
    <input id="${id}" data-docs-filter type="search" placeholder="Filter documentation" autocomplete="off">
    <p data-docs-filter-status role="status" hidden></p>
  </div>`;
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
  const generatedHtml = new Map();
  for (const htmlFile of htmlFiles) {
    generatedHtml.set(relative(output, htmlFile).split('\\').join('/'), await readFile(htmlFile, 'utf8'));
  }
  for (const htmlFile of htmlFiles) {
    const html = generatedHtml.get(relative(output, htmlFile).split('\\').join('/'));
    const pagePath = `/${relative(output, htmlFile).split('\\').join('/')}`;
    for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const reference = match[1];
      if (isExternalReference(reference)) continue;
      const targetUrl = new URL(reference, `https://pages.invalid${pagePath}`);
      let targetPath = decodeURIComponent(targetUrl.pathname).replace(/^\//, '');
      if (targetPath.endsWith('/')) targetPath += 'index.html';
      try {
        await access(join(output, targetPath));
      } catch {
        throw new Error(`generated link ${reference} in ${htmlFile} does not resolve`);
      }
      if (targetUrl.hash && targetPath.endsWith('.html')) {
        const target = generatedHtml.get(targetPath) ?? await readFile(join(output, targetPath), 'utf8');
        const fragment = decodeURIComponent(targetUrl.hash.slice(1));
        if (!target.includes(`id="${escapeHtml(fragment)}"`)) {
          throw new Error(`generated fragment ${reference} in ${htmlFile} does not resolve`);
        }
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
