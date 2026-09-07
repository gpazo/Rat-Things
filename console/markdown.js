import { lexer } from './marked.js';

// Parse Markdown, then construct an allowlisted DOM. Raw HTML is always text;
// images never fetch remote content. Links are resolved by the owning view.
export function renderMarkdown(value, { link, codeBlock }) {
  function render(tokens) {
    const fragment = document.createDocumentFragment();
    for (const token of tokens) {
      let node;
      switch (token.type) {
        case 'space': case 'def': continue;
        case 'code': node = codeBlock(token.text, token.lang ?? ''); break;
        case 'link':
          node = link(decodeEntities(token.href));
          node.append(render(token.tokens));
          break;
        case 'image':
          node = document.createTextNode(decodeEntities(token.text));
          break;
        case 'html': node = document.createTextNode(token.raw); break;
        case 'list':
          node = document.createElement(token.ordered ? 'ol' : 'ul');
          if (token.ordered) node.start = token.start;
          for (const item of token.items) {
            const li = document.createElement('li');
            if (item.task) {
              const checkbox = document.createElement('input');
              checkbox.type = 'checkbox';
              checkbox.disabled = true;
              checkbox.checked = item.checked;
              li.append(checkbox);
            }
            li.append(render(item.tokens));
            node.append(li);
          }
          break;
        case 'table': {
          node = document.createElement('div');
          node.className = 'markdown-table';
          const table = document.createElement('table');
          for (const [index, cells] of [token.header, ...token.rows].entries()) {
            const row = document.createElement('tr');
            for (const cell of cells) {
              const td = document.createElement(index === 0 ? 'th' : 'td');
              td.append(render(cell.tokens));
              row.append(td);
            }
            table.append(row);
          }
          node.append(table);
          break;
        }
        default: {
          const tag = { paragraph: 'p', heading: `h${Math.min((token.depth ?? 1) + 2, 6)}`, blockquote: 'blockquote', strong: 'strong', em: 'em', del: 'del', codespan: 'code', br: 'br', hr: 'hr' }[token.type];
          node = tag ? document.createElement(tag) : document.createDocumentFragment();
          if (token.tokens) node.append(render(token.tokens));
          else if (token.text) node.append(document.createTextNode(token.type === 'codespan' ? token.text : decodeEntities(token.text)));
        }
      }
      fragment.append(node);
    }
    return fragment;
  }
  return render(lexer(String(value ?? ''), { gfm: true, breaks: true }));
}

function decodeEntities(value) {
  // Only entity-shaped strings enter the decoder, never tags or attributes.
  return value.replace(/&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);/gi, (entity) => {
    const decoder = document.createElement('textarea');
    decoder.innerHTML = entity;
    return decoder.value;
  });
}
