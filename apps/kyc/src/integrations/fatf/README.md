# FATF жагсаалтын файл (`FATF_LIST_FILE`)

FATF нь machine-readable API өгдөггүй. Тиймээс `RealFatfClient` жагсаалтыг серверийн **JSON файлаас** уншина; файлыг
үйл ажиллагааны баг FATF-ийн бүрэн хуралдаан (plenary — жилд ~3 удаа: 2, 6, 10-р сар) бүрийн дараа **гараар** шинэчилнэ.
Эх сурвалж: fatf-gafi.org — "High-Risk Jurisdictions subject to a Call for Action" (→ `CALL_FOR_ACTION`) ба
"Jurisdictions under Increased Monitoring" (→ `INCREASED_MONITORING`).

## Формат

```json
{
  "version": "2026-10",
  "publishedAt": "2026-10-24",
  "entries": [
    { "countryCode": "XX", "countryName": "Example Land", "category": "CALL_FOR_ACTION", "listedOn": "2026-10-23" },
    { "countryCode": "XY", "countryName": "Sample Republic", "category": "INCREASED_MONITORING", "listedOn": "2026-02-20" }
  ]
}
```

(`XX`, `XY` нь ЖИШЭЭ код — бодит жагсаалт биш.)

| Талбар | Дүрэм |
| --- | --- |
| `version` | plenary сар `YYYY-MM`. Screening бүрийн бүртгэлд хадгалагдана → аудитаар жагсаалт хэр шинэ байсныг харна |
| `publishedAt` | файлыг баталсан огноо: `YYYY-MM-DD` эсвэл цагтай ISO-8601 (`Z` / оффсет заавал) |
| `entries[].countryCode` | ISO 3166-1 alpha-2, ТОМ үсгээр. Нэг улс **нэг л удаа** (хоёр категорид зэрэг байж болохгүй) |
| `entries[].category` | `CALL_FOR_ACTION` \| `INCREASED_MONITORING` |
| `entries[].listedOn` | тухайн улс энэ категорид орсон plenary-ийн огноо `YYYY-MM-DD` |

Хатуу шалгалт (`fatf-list.ts`): үл мэдэгдэх талбар, буруу формат, давхардсан улс, хоосон жагсаалт, 100-аас олон бичлэг,
256 KiB-ээс том файл — бүгд татгалзагдана. Нэг алдаа файлыг **бүхэлд нь** татгалзуулна (хэсэгчлэн хүлээн авахгүй).

## Шинэчлэх журам

1. FATF-ийн plenary-ийн дараах албан ёсны мэдэгдлээс хоёр жагсаалтыг дахин нягтлан файлыг засна (өөр хүн хоёр дахь нүдээр шалгахыг зөвлөнө).
2. Файлыг **атомаар** солино: түр нэрээр бичээд `mv` (хагас бичигдсэн файлыг kyc унших боломжгүй болгоно).
3. `POST /aml/lists/refresh`-ээр даруй хэрэгжүүлнэ (үгүй бол `AML_LIST_REFRESH_MINUTES`, анхдагч 360 мин хүртэл хүлээнэ).
4. Файл буруу бол өмнөх snapshot (≤ `maxStaleListHours`) хэвээр ажиллаж, шинэчлэл алдаатай гэж логд гарна; kyc дахин deploy хийх үед
   `NODE_ENV=production` + `INTEGRATION_MODE=real`-д буруу файлтай бол **эхлэхгүй**.

## Эрсдэл

Файл автоматаар хуучрахыг шалгадаггүй (хуучирсан жагсаалтаас болж бүх AML-ийг 503 болгох нь хэт хатуу). Үйл ажиллагааны
баг plenary бүрийн дараа шинэчлэхээ мартвал screening хуучин `version`-оор үргэлжилнэ — `version`-ийг тайлан / аудитаар хянана.
