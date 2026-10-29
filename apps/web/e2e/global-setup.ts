// `next dev` маршрутыг эхний хүсэлтэд компайлдаг (10–30 сек) — тестүүдийн эхнийх нь expect timeout-д баригдахгүйн тулд бүх маршрутыг урьдчилан дуудна.
const ROUTES = [
  '/merchant',
  '/merchant/leases',
  '/merchant/leases/new',
  '/merchant/leases/44444444-4444-4444-8444-444444444441',
  '/settings/merchants',
  '/settings/merchants/11111111-1111-4111-8111-111111111111',
  '/los/pos-leases',
];

export default async function globalSetup(): Promise<void> {
  const base = process.env.E2E_BASE_URL ?? 'http://localhost:3100';
  await Promise.all(
    ROUTES.map(async (route) => {
      try {
        await fetch(`${base}${route}`, { headers: { accept: 'text/html' } });
      } catch {
        // Дулаацуулалт л — амжилтгүй бол тест өөрөө алдааг харуулна.
      }
    }),
  );
}
