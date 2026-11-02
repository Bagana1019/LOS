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
}

/** `<button>` элементүүд (antd Button) */
export function buttons(html: string): RenderedButton[] {
  const found: RenderedButton[] = [];
  for (const match of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    found.push({ text: visibleText(match[2] ?? ''), disabled: /\sdisabled(=|\s|>|$)/.test(match[1] ?? '') });
  }
  return found;
}

export const buttonByText = (html: string, label: string): RenderedButton | undefined => buttons(html).find((b) => b.text === label);

/** `<a href>` линкүүд */
export function links(html: string): Array<{ href: string; text: string }> {
  return [...html.matchAll(/<a\b[^>]*\shref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => ({ href: (m[1] ?? '').replace(/&amp;/g, '&'), text: visibleText(m[2] ?? '') }));
}

export interface RenderedRadio {
  value: string;
  checked: boolean;
  disabled: boolean;
  label: string | null;
}
/** `<input type="radio">` */
export function radios(html: string): RenderedRadio[] {
  return [...html.matchAll(/<input\b([^>]*type="radio"[^>]*)\/?>/g)].map((m) => {
    const attrs = m[1] ?? '';
    return {
      value: /\svalue="([^"]*)"/.exec(attrs)?.[1] ?? '',
      checked: /\schecked(=|\s|\/|$)/.test(attrs),
      disabled: /\sdisabled(=|\s|\/|$)/.test(attrs),
      label: /\saria-label="([^"]*)"/.exec(attrs)?.[1] ?? null,
    };
  });
}

/** Элементийн `data-<name>="<value>"` атрибутуудыг эрэмбэтэйгээр */
export const dataAttrs = (html: string, name: string): string[] => [...html.matchAll(new RegExp(`\\sdata-${name}="([^"]*)"`, 'g'))].map((m) => m[1] ?? '');
