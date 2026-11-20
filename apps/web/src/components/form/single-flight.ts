import { useState } from 'react';

/**
 * Нэг удаад нэг л task ажиллуулна; ажиллаж байхад ирсэн дуудлагыг (давхар товшилт) чимээгүй алгасна, `undefined` буцаана.
 * Түгжээ СИНХРОН: React-ийн `isPending` нь дараагийн task-д л шинэчлэгддэг тул `loading`/`disabled` дан ганц хурдан давхар товшилтыг барьдаггүй (F2-14).
 * Task-ийн алдаа дуудагч руу дамжина (mutation-ий `error` төлөвөөр харуулна); түгжээ `finally`-д тайлагдана.
 */
export function createSingleFlight(): <T>(task: () => Promise<T>) => Promise<T | undefined> {
  let busy = false;
  return async <T>(task: () => Promise<T>): Promise<T | undefined> => {
    if (busy) return undefined;
    busy = true;
    try {
      return await task();
    } finally {
      busy = false;
    }
  };
}

/** Компонент (форм) бүрт өөрийн түгжээ: рендер хооронд хадгалагдана. */
export function useSingleFlight(): ReturnType<typeof createSingleFlight> {
  return useState(createSingleFlight)[0];
}
