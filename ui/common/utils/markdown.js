import { Marked } from '/common/vendor/marked.esm.js';
import DOMPurify from '/common/vendor/dompurify.esm.js';
import hljs from '/common/vendor/highlight.esm.js';
import { icons } from '/common/utils/icons.js';

/**
 * Markdown renderer for LLM output, shared by chat + orchestrator pages.
 *
 * Pipeline: marked (GFM: tables, nested lists, strikethrough, ...) →
 * highlight.js for fenced code blocks → DOMPurify sanitize.
 *
 * Usage:
 *   container.classList.add('md-body');       // styles: /common/styles/markdown.css
 *   container.innerHTML = renderMarkdown(text);
 *
 * Code blocks emit a header with copy + download buttons. Download is handled
 * here by a module-level delegate; bind a delegated click handler for
 * `.md-code-copy` in the page (see chat-page.js / orchestrator-page.js).
 */

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Syntax-highlight code, falling back to escaped plain text for unknown
 * languages or highlighter errors. Returns HTML-safe markup either way.
 */
function highlightCode(code, language) {
  if (language && hljs.getLanguage(language)) {
    try {
      return hljs.highlight(code, { language, ignoreIllegals: true }).value;
    } catch {
      // fall through to plain rendering
    }
  }
  return escapeHtml(code);
}

// Dedicated instance so we don't mutate the shared `marked` singleton.
const marked = new Marked({
  gfm: true,
  breaks: true, // single newlines become <br>, matches LLM chat conventions
  renderer: {
    code({ text, lang }) {
      const language = (lang || '').split(/\s+/)[0].toLowerCase();
      return (
        `<div class="md-code-block">` +
        `<div class="md-code-header">` +
        `<span class="md-code-lang">${escapeHtml(language) || 'code'}</span>` +
        `<div class="md-code-actions">` +
        `<button type="button" class="md-code-download" data-lang="${escapeHtml(language)}" aria-label="Download code">${icons.download('', 14)}</button>` +
        `<button type="button" class="md-code-copy" aria-label="Copy code">${icons.copy('', 14)}</button>` +
        `</div>` +
        `</div>` +
        `<pre><code>${highlightCode(text, language)}</code></pre>` +
        `</div>`
      );
    },
    codespan({ text }) {
      return `<code class="md-inline-code">${escapeHtml(text)}</code>`;
    },
  },
});

// Extensions for the languages LLM chat actually emits; anything else is .txt.
const CODE_EXTENSIONS = {
  python: 'py', javascript: 'js', jsx: 'jsx', typescript: 'ts', tsx: 'tsx',
  rust: 'rs', go: 'go', java: 'java', c: 'c', cpp: 'cpp', csharp: 'cs',
  ruby: 'rb', php: 'php', swift: 'swift', kotlin: 'kt', sql: 'sql',
  html: 'html', css: 'css', json: 'json', yaml: 'yml', yml: 'yml',
  toml: 'toml', xml: 'xml', markdown: 'md', md: 'md',
  bash: 'sh', sh: 'sh', shell: 'sh', dockerfile: 'Dockerfile',
};

// ponytail: one document-level delegate instead of wiring a handler into every
// page that renders markdown — downloading needs no page state. Module scope,
// so it binds once no matter how many pages import this.
document.addEventListener('click', (e) => {
  const btn = e.target.closest?.('.md-code-download');
  if (!btn) return;
  const code = btn.closest('.md-code-block')?.querySelector('code')?.textContent;
  if (!code) return;
  const ext = CODE_EXTENSIONS[btn.dataset.lang] || 'txt';
  const url = URL.createObjectURL(new Blob([code], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = ext === 'Dockerfile' ? 'Dockerfile' : `snippet.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
});

// LLM output is untrusted: force links to open in a new tab without a
// window.opener reference. DOMPurify strips target/rel otherwise.
//
// A link whose href DOMPurify removed (an unknown/unsafe scheme) is dead — most
// commonly an agent hallucinating a "download" link, e.g. opencode's
// `[Download foo.md](sandbox:/workspace/foo.md)`. Left alone it renders as an
// underlined, do-nothing link that masquerades as a real download next to the
// actual file chip. Mark it so CSS renders it as plain text.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName !== 'A') return;
  if (node.hasAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  } else {
    node.classList.add('md-dead-link');
  }
});

/**
 * Render untrusted markdown to sanitized HTML.
 * @param {string} text
 * @returns {string} HTML safe to assign to innerHTML
 */
export function renderMarkdown(text) {
  if (!text) return '';
  let html;
  try {
    html = marked.parse(text);
  } catch {
    // Never let a parser edge case blank out a chat message.
    html = `<p>${escapeHtml(text)}</p>`;
  }
  // Tables need a scroll container to avoid blowing out the chat bubble on
  // narrow screens. Markdown can't nest tables, so plain wrapping is safe.
  html = html
    .replace(/<table>/g, '<div class="md-table-wrap"><table>')
    .replace(/<\/table>/g, '</table></div>');
  return DOMPurify.sanitize(html);
}
