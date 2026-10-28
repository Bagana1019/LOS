import type { NextConfig } from 'next';

// Нэвтрэх хуудас, батлах/олголтын дэлгэцийг өөр сайт iframe-д оруулж (clickjacking) болохгүй. Бүрэн CSP (script nonce) нь тусдаа ажил.
const securityHeaders = [
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'same-origin' },
];

const config: NextConfig = {
  transpilePackages: ['@los/ui', '@los/contracts', '@los/calc'],
  output: 'standalone',
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};
export default config;
