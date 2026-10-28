// Бүх дуудлага gateway руу. Сервис рүү шууд дуудахгүй (CLAUDE.md §3).
export const API = process.env.NEXT_PUBLIC_GATEWAY_URL ?? 'http://localhost:4000/api';
