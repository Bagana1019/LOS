# BSA persistence (хадгалалтын давхарга)

BSA (модуль 10)-ийн бүх өгөгдөл хадгалалт нэг port-оор (`BsaRepository`) дамжина. Хоёр хэрэгжүүлэлттэй, нэг гэрээний тестээр ижил
семантиктай нь батлагдсан:

| Хэрэгжүүлэлт | Файл | Хэзээ |
| --- | --- | --- |
| `PrismaBsaRepository` | `prisma-bsa.repository.ts` (+ `prisma-*.ts`) | Үйлдвэрлэл, PostgreSQL `scoring` schema |
| `InMemoryBsaRepository` | `memory-bsa.repository.ts` | pipeline/controller-ийн unit тест, DB-гүй орчин |

Хүснэгт, migration, seed: `apps/scoring/prisma/README.md`.

## Импортын дүрэм

- `./index` (barrel) нь Prisma-д ХАМААРАХГҮЙ: port, төрөл, алдаа, `InMemoryBsaRepository`, dedupe туслахууд. Pipeline, controller, тестүүд эндээс импортлоно.
- PostgreSQL хэрэгжүүлэлт (`BsaPersistenceModule`, `PrismaService`, `PrismaBsaRepository`) нь generated client шаардана; зөвхөн app module
  `./persistence.module`-оос импортлоно. Generated client-ийг харьцангуй замаар (`node_modules/.prisma/client-scoring`) импортолдог, учир нь
  vitest/Vite `.prisma/...` нэрийг шийдэж чадахгүй.
- Бүх Nest constructor параметр дээр тодорхой `@Inject(Token)` байна (vitest `emitDecoratorMetadata` дэмждэггүй).

```ts
// Nest модульд
@Module({ imports: [BsaPersistenceModule.register({ imports: [CommonModule] })] })
export class BsaModule {}

// Үйлчилгээнд
constructor(@Inject(BSA_REPOSITORY) private readonly repo: BsaRepository) {}

// Unit тестэд
const repo = new InMemoryBsaRepository({ now: () => new Date('2026-01-01T00:00:00Z') });
repo.seedConfig('org-1', { categories: DEFAULT_BSA_CATEGORIES, rules: DEFAULT_BSA_RULES });
```

`PII_CIPHER` (`../infra.ports.ts`) -ийг өөр модуль гаргана; `register({ imports })`-д тэр модулийг өг. `options` нь транзакцийн timeout, багцын
хэмжээг тохируулна (`PRISMA_BSA_REPOSITORY_DEFAULTS`). Тестэд `testing/test-pii-cipher.ts` (`TestPiiCipher`, AES-256-GCM) ашигла; үйлдвэрлэлд ашиглахгүй.

## Port-ын бүтэц

`BsaRepository` нь бүлгүүдтэй: `analyses`, `importJobs`, `transactions`, `events`, `config`, `retention`, `runInTransaction`.

- `analyses.create` нь (org, application, customer) тутамд `version`-ыг 1-ээс нэмэгдүүлж олгоно (INT-7). PostgreSQL дээр `pg_advisory_xact_lock`
  ашиглан зэрэгцээ дуудлагад ч давхардахгүй. `findLatest`, `listLatestByApplication` нь хамгийн сүүлийн хувилбарыг буцаана.
- `analyses.addOwnAccounts` нь дансыг нормчилж, давхардлыг нь арилгаж атомаар нэмнэ (`SELECT ... FOR UPDATE`); бүх жагсаалтыг буцаана.
- `importJobs.create` нь (analysis, sha256) давтагдвал `BsaDuplicateError('IMPORT_FILE', existingId)`. `incrementRowsDone` нь атомар `rows_done += delta`.
- `transactions.bulkInsert` нь нэг ажлын мөрүүдийг нэг транзакцид нэмнэ; (analysis, dedupeKey) давхцсан мөрийг АЛГАСНА (алдаа биш), `{inserted, skipped}` буцаана.
  Мөр буруу бол `BsaInvalidError` ба юу ч хадгалагдахгүй.
- `transactions.updateClassifications` нь автомат ангиллын үр дүнг багцаар хадгална; гар засвартай (`manualOverride`) мөрийг өөрчлөхгүй, `{updated, skipped}`.
- `transactions.setManualCategory` (BSA-FR-3.3): итгэл 100, `isOwnTransfer=false`, `manualOverride=true`, бүлгийг ангиллын сангаас авна. Ангилал байхгүй/идэвхгүй
  эсвэл чиглэл таарахгүй бол `BsaInvalidError`.
- `transactions.list` нь шүүлт (`importJobId`, `dateFrom/dateTo`, `direction`, `categoryCodes`, `channel`, `ownTransfer`, `manualOverride`, `amountMin/amountMax`, `text`; бүгд AND) ба эрэмбэ (`DATE_ASC/DESC`, `AMOUNT_ASC/DESC`) дэмжинэ. Эрэмбэ тогтвортой
  (огноо, цаг (хоосон нь түрүүлж), seq, id), хуудаслалт `limit` (анхдагч 50, дээд 1000) + `offset`. `text` хайлт нь аппликейшнд (шифрлэгдсэн талбар тул)
  тайлж хайна: `description`, `counterpartyName`, `counterpartyAccount`, том жижиг үсэг үл ялгана; нэг шинжилгээний мөрийн тоогоор O(n).
- `events.append/list`: append-only түүх (NFR-4), сүүлийнх нь түрүүлж. Үйлдлийн кодын жишээ (repository хязгаарлахгүй): `IMPORT_COMPLETED`,
  `RECLASSIFIED`, `RECALCULATED`, `PUSHED_TO_LOS`. `detail` нь PII агуулахгүй (тоо, код, id).
- `config.listCategories/listRules` нь идэвхтэй мөрийг л буцаана (`listRules`: `BsaRuleDef & { id }`). `createRule` нь ангилал байгаа, чиглэл таарч
  байгааг шалгана; байгалийн түлхүүр давтагдвал `BsaDuplicateError('RULE')`. `setRuleActive` нь идэвхжүүлэх/идэвхгүй болгох.
- `retention.findExpired(cutoff, limit, orgId?)` нь `createdAt < cutoff` (cutoff-ыг оруулахгүй), хуучин нь түрүүлж. `purge(analysisId)` нь шинжилгээ ба
  бүх хүүхэд мөрийг (cascade) устгаад object store-ын түлхүүрүүдийг (`objectKeys`) буцаана.

### Retention урсгал (BSA-BR-8, NFR-5)

1. `findExpired(cutoff, limit)` -> жагсаалт.
2. Шинжилгээ тутамд `purge(id)` -> DB-ээс устгаад `objectKeys` буцаана.
3. DB commit-ийн ДАРАА `ObjectStore.delete(key)`-г key бүрд дууд. Эхлээд DB, дараа нь object store: object store устгах нь амжилтгүй болбол өгөгдөл
   хаягдсан файл болж үлдэх (аюулгүй тал), харин эсрэгээр бол DB-д файлгүй мөр үлдэнэ. Дуудагч үүнд хариуцлага хүлээнэ; repository object store-г мэдэхгүй.

### Транзакц ба outbox

```ts
await repo.runInTransaction(async (txRepo, tx) => {
  await txRepo.analyses.update(id, { status: 'ANALYZED', summary, analyzedAt });
  await events.enqueue(tx, domainEvent); // DomainEventPublisher: outbox-д ИЖИЛ транзакцид (CLAUDE.md §3.2(4))
});
```

- Callback шидвэл бүх бичилт буцна. Nested `runInTransaction` нь гадаад транзакцдаа нэгдэнэ.
- Prisma дээр `tx` нь `Prisma.TransactionClient`; in-memory дээр `tx` нь царцаасан тэмдэг объект (`{ inMemoryTransaction: true }`). In-memory нь тусгаарлалтгүй (mutex + snapshot-оор буцаана),
  тиймээс зэрэгцээ транзакцийн зан төлөв (өрсөлдөөн) шалгах тест нь PostgreSQL дээр л утгатай.

## Dedupe түлхүүр (BSA-FR-2.4)

Давхцсан хугацаатай хуулгын (жишээ нь 1-6 сар, 4-9 сар) ижил гүйлгээг нэг л удаа хадгалахын тулд pipeline нь мөр тутамд `dedupeKey`, файл тутамд `statementKey` өгнө:

```ts
const accountKey = accountKeyOf(accountNo, (p) => cipher.hash(p));      // statementKey болгон мөн ашиглана
const keys = buildDedupeKeys(accountKey, rows, (p) => cipher.hash(p));  // rows-той зэрэгцсэн, файлын дарааллаар
```

- Түлхүүр = hash(данс | огноо | цаг (`HH:mm:ss`-д нэгтгэсэн) | чиглэл | дүн | үлдэгдэл | нормчилсон утга | n дэх давтамж).
- Нэг файл доторх бүх талбараараа ижил мөр (жишээ нь үлдэгдэлгүй хуулгад 2 ижил худалдан авалт) жинхэнэ ялгаатай гүйлгээ байж болох тул n дэх давтамж бүр
  өөр түлхүүр авна. Хязгаарлалт: давхцлын захад ижил мөрүүдийн нэг нь хоёр файлын аль нэгэнд л орсон бол тоо нь файлуудын хамгийн их давтамжтай таарна.
- `statementKey`, `dedupeKey` нь ЗААВАЛ `PiiCipher.hash` утга (түүхий дансны дугаар БИШ). Түлхүүр импортын ажлын id-аас хамаарахгүй (account-аас үүснэ),
  тиймээс ижил файлыг дахин оруулах эсвэл давхцсан хуулга оруулах нь дахин нэмэгдэхгүй.

## PII ба логийн дүрэм

- Шифрлэх газар зөвхөн repository: регистр, нэр, утас, зарласан/өөрийн данс, файлын нэр, дансны дугаар, IBAN, эзэмшигчийн нэр, гүйлгээний утга, харьцсан данс/нэр.
  Регистр нь `register_no_hash` (түлхүүртэй hash) + шифрлэгдсэн snapshot-д л байна.
- ЛОГТ PII бичихгүй. Алдааны мессеж зөвхөн талбарын зам (`field`) ба zod кодыг агуулна, утгыг агуулахгүй. `PrismaService` нь `log: ['warn']`,
  `errorFormat: 'minimal'`.
- `errors_json`, `warnings_json`, `bsa_analysis_event.detail_json` нь PII агуулах ЁСГҮЙ (зөвхөн код, мөр/хуудасны дугаар, тоо).
- Фикстур бүр СИНТЕТИК (`repository.contract.ts`-д тэмдэглэсэн). Жинхэнэ хуулга ашиглахгүй.

## Харьцангуй зан төлөв

- Мөнгө 2 орны нарийвчлал, `ROUND HALF AWAY FROM ZERO` (аравтын мөр дээр). `confidence` 0..100 (`numeric(5,2)`), хувь `numeric(7,4)`.
- Эрэмбэ collation-оос хамаарахгүй: SQL зөвхөн огноо, тоо, uuid, цагийн мөрөөр эрэмбэлнэ; кодын мөрийг JS-д эрэмбэлнэ (C ба ICU баазад ижил).
- Tenant хязгаарлалт (`TenantScope {orgId, branchId?}`) нь дамжуулсан газраа л мөрдөгдөнө (`analyses.getById(id, scope)` зэрэг). Хүүхэд мөр
  (job/transaction/event) нь шинжилгээний `analysisId`-аар хандагдана; дуудагч (controller/guard) эхлээд шинжилгээг scope-оор шалгах ёстой.
- `analyses.update` нь `branchId` өөрчлөгдвөл хүүхэд хүснэгтүүдийн (job, transaction, event) `branch_id`-г мөн нэг транзакцид шилжүүлнэ.
- Тохиргооны сан (`bsa_category`, `bsa_rule`) нь org тутамд; анхны өгөгдлийг `prisma/seed.ts` суулгана.

## Тест

```bash
cd apps/scoring
# DB-гүй: in-memory + нэгж тест (Prisma-ийн гэрээний тест алгасагдана)
npx vitest run src/modules/bsa/common/persistence
# PostgreSQL-тэй: DB-ийн нэрэнд "test" заавал орно (тест бүрийн өмнө TRUNCATE)
TEST_DATABASE_URL=postgresql://localhost/los_bsa_test npx vitest run src/modules/bsa/common/persistence
```

`repository.contract.ts` нь `describeRepositoryContract(name, factory)`-ийг экспортолно; хоёр хэрэгжүүлэлт ижил тестүүдийг ажиллуулна. Шинэ зан төлөв нэмэхдээ
эхлээд port + гэрээний тест, дараа нь хоёр хэрэгжүүлэлтийг өөрчил.

## Анхааруулга

Банкны хуулгын parser-ууд (энэ unit-д биш) бодит хуулгаар БАТЛАГДААГҮЙ: зөвхөн синтетик дээж дээр тест хийгдсэн. Энэ давхарга parser-ийн
зөв байдлыг баталгаажуулахгүй, зөвхөн parser-ийн гаргасныг хадгална.
