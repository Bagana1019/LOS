/** SSR HTML-ээс харагдах текстийг гаргана (тестэд хайх зориулалттай) */
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

export interface RenderedButton {
  text: string;
  disabled: boolean;
  href: string | null;
}

/** `<button>` ба товч шиг `<a class="ant-btn">` элементүүд */
export function buttons(html: string): RenderedButton[] {
  const found: RenderedButton[] = [];
  for (const match of html.matchAll(/<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
    const [, tag, attrs, inner] = match;
    if (tag === 'a' && !/class="[^"]*ant-btn/.test(attrs)) continue;
    found.push({
      text: visibleText(inner),
      disabled: /\sdisabled(=|\s|$)/.test(attrs) || /aria-disabled="true"/.test(attrs),
      href: /\shref="([^"]*)"/.exec(attrs)?.[1].replace(/&amp;/g, '&') ?? null,
    });
  }
  return found;
}

export function buttonByText(html: string, label: string): RenderedButton | undefined {
  return buttons(html).find((b) => b.text === label);
}
