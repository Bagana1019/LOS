import type { NextConfig } from 'next';

// FR-11.4: зээлдэгчийн нийтийн хуудсууд (/sign/<token>, /verify/<code>) — токен URL-д байдаг тул referrer алдагдуулахгүй, кэшлэхгүй, индекслэхгүй, iframe-д оруулахгүй.
const publicEsignHeaders = [
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
  { key: 'Cache-Control', value: 'no-store' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
];

const config: NextConfig = {
  transpilePackages: ['@los/ui', '@los/contracts', '@los/calc'],
  output: 'standalone',
  async headers() {
    return [
      { source: '/sign/:path*', headers: publicEsignHeaders },
      { source: '/verify/:path*', headers: publicEsignHeaders },
    ];
  },
};
export default config;
