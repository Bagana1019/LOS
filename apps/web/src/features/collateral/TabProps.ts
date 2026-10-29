import type { CollateralView } from '@los/contracts';
import type { WriteState } from '../documents/shared/access';

/** Дэлгэрэнгүй самбарын табуудын нийтлэг props. */
export interface TabProps {
  applicationId: string;
  item: CollateralView;
  write: WriteState;
  /** Мутаци бүрийн дараа (wizard-н алхмын төлөв шинэчлэх). */
  onChanged?: () => void;
}
