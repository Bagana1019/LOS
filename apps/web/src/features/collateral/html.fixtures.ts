// SSR HTML-ийн тестийн туслах (component тест `renderToString`-ээр; jsdom ашиглахгүй).

/** HTML-ээс харагдах текст. */
export function visibleText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `data-testid="…"` бүхий элементүүдийн (эхлэх таг) атрибутууд. */
export function tagsWithTestId(html: string, testId: string): string[] {
  return [...html.matchAll(new RegExp(`<[a-z0-9]+\\b[^>]*data-testid="${testId}"[^>]*>`, 'g'))].map((m) => m[0]);
}

/** `data-testid` бүхий элементийн доторх текст (эхний таарсан; ижил нэртэй таг дотор шууд үүрлэхгүй гэж үзнэ). */
export function textOfTestId(html: string, testId: string): string | null {
  const start = html.search(new RegExp(`<[a-z0-9]+\\b[^>]*data-testid="${testId}"`));
  if (start === -1) return null;
  const tag = /^<([a-z0-9]+)/.exec(html.slice(start))?.[1] ?? 'div';
  const rest = html.slice(start);
  let depth = 0;
  let end = rest.length;
  for (const m of rest.matchAll(new RegExp(`<(/?)${tag}\\b[^>]*>`, 'g'))) {
    depth += m[1] === '/' ? -1 : 1;
    if (depth === 0) {
      end = (m.index ?? 0) + m[0].length;
      break;
    }
  }
  return visibleText(rest.slice(0, end));
}

export function countOf(html: string, needle: string | RegExp): number {
  return typeof needle === 'string' ? html.split(needle).length - 1 : [...html.matchAll(needle)].length;
}
