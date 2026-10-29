// Origination-ийн үүсгэгдсэн Prisma client (schema.prisma `generator.output = ../node_modules/.prisma/client-origination`). Persistence доторх БҮХ import энэ файлаар дамжина.
//
// Яагаад харьцангуй зам: `.prisma/client-origination` нэртэй bare specifier-ийг tsc/Node (CommonJS) зөв шийддэг боловч Vite/Vitest нь `.`-аар эхэлсэн нэрийг
// package гэж танихгүй ("Failed to load url .prisma/client-origination"). Харьцангуй зам нь src болон dist (nest build) хоёуланд ижил гүнтэй тул адил ажиллана.
// Хэрэв vitest.config-д alias тавьж bare specifier руу буцаах бол зөвхөн энэ нэг мөрийг солино.
export * from '../../../../../node_modules/.prisma/client-origination';
