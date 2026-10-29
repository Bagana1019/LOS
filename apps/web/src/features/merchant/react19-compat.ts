import { unstableSetRender } from 'antd';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
// antd 5 нь React 19-тэй static API (message, Modal.confirm, товчны wave) ашиглахад render функцийг гараар заавал өгөх шаардлагатай.
// Албан ёсны `@ant-design/v5-patch-for-react-19` багцын агуулга — шинэ dependency нэмэхгүйн тулд энд шууд бичив.

type Host = (Element | DocumentFragment) & { __mpRoot?: Root };
let installed = false;

export function installAntdReact19Compat(): void {
  if (installed) return;
  installed = true;
  unstableSetRender((node: ReactElement, container: Element | DocumentFragment) => {
    const host = container as Host;
    host.__mpRoot ??= createRoot(container);
    const root = host.__mpRoot;
    root.render(node);
    return async () => {
      await Promise.resolve();
      root.unmount();
      delete host.__mpRoot;
    };
  });
}

installAntdReact19Compat();
