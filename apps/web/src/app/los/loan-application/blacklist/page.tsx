import { redirect } from 'next/navigation';

// Хуучин хаяг (хавчуургад үлдсэн байж болно) — цэс одоо дээд түвшинд: /los/blacklist
export default function Page() {
  redirect('/los/blacklist');
}
