// `@types/react-dom` web-ийн dependency биш тул antd-ийн React 19 compat-д хэрэгтэй хамгийн бага төрлийг зарлав.
declare module 'react-dom/client' {
  import type { ReactNode } from 'react';
  export interface Root {
    render(children: ReactNode): void;
    unmount(): void;
  }
  export function createRoot(container: Element | DocumentFragment): Root;
}
