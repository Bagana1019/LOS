import type { NextConfig } from 'next';

// Нэвтрэх хуудас, батлах/олголтын дэлгэцийг өөр сайт iframe-д оруулж (clickjacking) болохгүй. Бүрэн CSP (script nonce) нь тусдаа ажил.
const securityHeaders = [
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'same-origin' },
];

// FR-11.4: зээлдэгчийн нийтийн хуудсууд (/sign/<token>, /verify/<code>) — токен URL-д байдаг тул referrer алдагдуулахгүй, кэшлэхгүй, индекслэхгүй, iframe-д оруулахгүй.
const publicEsignHeaders = [
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
  { key: 'Cache-Control', value: 'no-store' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  { key: 'X-Frame-Options', value: 'DENY' },
];

const config: NextConfig = {
  transpilePackages: ['@los/ui', '@los/contracts', '@los/calc'],
  output: 'standalone',
  async headers() {
    return [
      // Нийтийн хуудсууд өөрийн (илүү хатуу) толгойтой тул ерөнхий дүрмээс хасна — ижил толгой хоёр дүрмээс давхар орохгүй.
      { source: '/((?!sign(?:/|$)|verify(?:/|$)).*)', headers: securityHeaders },
      { source: '/sign/:path*', headers: publicEsignHeaders },
      { source: '/verify/:path*', headers: publicEsignHeaders },
    ];
  },
};
export default config;
