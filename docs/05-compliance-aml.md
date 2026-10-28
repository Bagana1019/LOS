# LOS Radix — Compliance & AML (хориг арга хэмжээ, мөнгө угаахтай тэмцэх, дотоод хар жагсаалт)

Хамрах шаардлага: FR-2.5 (PEP, мөнгө угаахын эрсдэлийн оноо), FR-3.4 (хар жагсаалтын автомат шалгалт), FR-6.5 (барьцаалагчийн KYC), FR-13.1 (хар жагсаалт CRUD, импорт), BR-9 (хар жагсаалт — зөвхөн анхааруулга). FR-13.5 (хар жагсаалтын аудит) одоогоор дутуу — §10.
Эзэмшигч: `apps/kyc` (тулгалт, шийдвэрлэх урсгал), `apps/origination` (дотоод хар жагсаалтын өгөгдөл ба CRUD).

## 1. Юу хийдэг вэ

Зээлдэгч, хамтран зээлдэгч, батлан даагч, барьцаалагч бүрийг гурван жагсаалттай автоматаар тулгана:

| Жагсаалт (`ScreeningList`) | Эх сурвалж | Тулгах арга | Adapter |
| --- | --- | --- | --- |
| `UN_SC` | НҮБ-ын Аюулгүйн Зөвлөлийн нэгдсэн хориг арга хэмжээний жагсаалт | Регистр/бичиг баримтын дугаарын яг тохирол + нэрийн бүдэг тулгалт (кирилл ↔ латин, alias, төрсөн он) | `integrations/un-sc/` |
| `FATF` | FATF-ийн өндөр эрсдэлтэй юрисдикцууд: `CALL_FOR_ACTION` (хар), `INCREASED_MONITORING` (саарал) | Улсын код (ISO alpha-2). FATF хувь хүн жагсаадаггүй тул иргэншил/оршин суугаа/бүртгэлтэй улсаар | `integrations/fatf/` |
| `INTERNAL_BLACKLIST` | `origination.blacklist` (найдваргүй зээлдэгч) | Регистрийн яг тохирол (blind index hash: HMAC-SHA256, `DATA_INDEX_KEY`). Нэрээр тулгахгүй — нийтлэг нэрэнд хуурамч тохирол их гарна | kyc `blacklist_projection` |

Шалгалт **үргэлж гурван жагсаалтаар** хийгдэнэ. `AmlScreenRequest`-д `lists` талбар байхгүй, клиентээс `lists` ирвэл zod чимээгүй хаяна (strip). Дэд олонлогоор шалгасан "цэвэр" үр дүн блоклосон шалгалтыг дарж болохгүй тул үүнийг зориуд хориглосон. `listVersions` үргэлж `UN_SC`, `FATF`, `INTERNAL_BLACKLIST` (`'live'`) гурван түлхүүртэй.

Үр дүн бүрт: `status`, `blocking`, hit-ийн жагсаалт (нотолгоотой), эрсдэлийн оноо 0–100 ба түвшин (`LOW|MEDIUM|HIGH`), шалгасан жагсаалт бүрийн хувилбар.

## 2. Архитектур

```mermaid
flowchart LR
  subgraph origination
    BL[blacklist CRUD + import<br/>FR-13.1]
  end
  subgraph kyc
    AML[aml: /api/aml/screen<br/>engine + review]
    WL[WatchlistService<br/>cache · fail-closed]
    PRJ[(blacklist_projection)]
    DB[(aml_check · aml_hit)]
  end
  UN[[UN_SC adapter<br/>Mock | Real]]
  FA[[FATF adapter<br/>Mock | Real]]
  BL -- BlacklistEntryChanged · outbox → Redis Streams --> PRJ
  origination -- sync REST --> AML
  AML --> WL --> UN & FA
  AML --> PRJ
  AML --> DB
  AML -- AmlScreeningCompleted · AmlHitReviewed --> DWH[dwh-sync · origination]
```

CLAUDE.md §3.2-ийн дүрмийг дагасан: origination → kyc sync REST; kyc origination-ийг дуудахгүй, хар жагсаалтыг **event-ээр projection** хийж хадгална (cross-schema FK-гүй); бизнес мөр ба event нэг транзакцид outbox-д; гадаад жагсаалт `interface + Mock + Real`, `INTEGRATION_MODE`-оор сонгоно.

**Хадгалалт.** AML-ийн нэгтгэл нь kyc schema-н `aml_check` (нэг шалгалтын нэгтгэл), `aml_hit`, `blacklist_projection` хүснэгтэд; incremental migration `apps/kyc/prisma/migrations/20261029000000_aml_check` (baseline `20261028000000_init`-ийг хөндөөгүй). docs/03-ийн `kyc.aml_screening` (жагсаалт тус бүрийн мөр) өөрчлөгдөөгүй, энэ модуль ашигладаггүй. `origination.blacklist` baseline-д аль хэдийн байсан (`register_no_hash`, `register_no_encrypted`); `apps/origination/prisma/migrations/20261029000000_blacklist_aml` нь `branch_id` багана, `unique(org_id, register_no_hash, list_type)`, `index(org_id, is_active)` нэмсэн. `registered_by` нь model-д nullable хэвээр, харин модуль үргэлж `X-User-Id`-ээр бөглөнө.

**Суурь (Модуль 0).** kyc, origination хоёул `CommonModule.forRoot()` (глобал `ContextAuthGuard`, `AllExceptionsFilter`, контекст middleware), сервисийн `PrismaService` (`PrismaModule`, глобал; модуль өөрийн PrismaClient үүсгэхгүй, холболт/унтраалтыг апп `bootstrapService` + `enableShutdownHooks`-оор удирдана), `EventsModule.forRoot` (outbox relay), `HealthModule` (`GET /api/health`, `/api/health/ready`)-ийг ашиглана. Outbox-ийг relay worker Redis Stream `los:events` руу гаргана; `BlacklistProjectionService` нь `BlacklistEntryChanged`-ийг consumer group `kyc`-ээр сонсоно (§8).

## 3. Тулгалтын алгоритм

Нэр, босго нь `AmlPolicy`-оос (BR утгыг hardcode хийхгүй, CLAUDE.md §6.2). Харин алгоритмын дотоод тогтмолууд — `PAIR_MIN` = 0.80, `JOINED_MIN` = 0.80, `JOINED_MAX_EDITS` = 1, `VARIANT_SCORE_CAP` = 0.97, `VOWEL_SCORE_CAP` = 0.93, `DIGIT_CONFLICT_CAP` = 0.5 — бодлогод биш matching кодонд байна (DECISIONS).

### 3.1 Нэрийг нормчлох (`matching/normalize.ts`)

Дараалал чухал (`normalizeName`; idempotent):

1. **NFKC + жижиг үсэг.** NFKC эхэлж орно: NFKD-ийг эхэлж хийвэл `ё→е`, `й→и` болж `yo` алдагдана (`Пётр` → `pyotr`, `petr` биш).
2. **Кирилл → латин** (`translit.ts`, MNS 5217-ийн хялбаршуулсан хувилбар): `ө→o`, `ү→u`, `ж→j`, `х→kh`, `ы→y`, `й→i`, `ё→yo`, `щ→shch`, `ъ`/`ь` унана. Казах (`ә ғ қ ң ұ һ ҳ ҷ җ`), украин (`і ї є ґ`), беларусь (`ў`), серб/македон (`ђ ћ ј љ њ џ ѕ`) зэрэг кирилл үсэг бүр хүснэгтэд орсон тул латин руу орохгүй үлдэх кирилл (холимог токен) гарахгүй. Хүснэгтээс гадуурх ховор/түүхэн кирилл тэмдэгт унана.
3. **Латин үсгийн хүснэгт.** NFKD-ээр суурь үсэг + diacritic болж задрахгүй латин үсгийг ASCII болгоно: `ı→i, đ→d, ð→d, ł→l, ø→o, æ→ae, œ→oe, ß→ss, þ→th` (`Kılıç ~ Kilic`, `Đức ~ Duc`, `Bjørn ~ Bjorn`). НҮБ-ын жагсаалтын нэр ASCII, иргэний бичиг баримт эдгээр үсгээр бичигддэг.
4. **NFKD → diacritic (mark) устгах.**
5. **Цэвэрлэгээ:** бүх төрлийн зураас (`\p{Pd}`), `_ . , / \` → зай (токен тусгаарлана: `Al-Rashid` → `al rashid`); апостроф/хашилт болон үсэг, цифр, зайнаас бусад тэмдэгт устна; олон зай нэг болно.
6. **Fold:** `kh→h, ph→f, ck→k, zh→j, q→k, w→v, x→ks` ба **давхар латин үсэг нэг болно** (`Muhammad ~ Muhamad`). `zh→j`: орос/казах/НҮБ-ын `zh` нь MNS 5217-ийн `ж = j`-тэй ижил (`Жаргал ~ Zhargal`, `Жуков ~ Zhukov`). Цифрийн давхардал хадгалагдана (`88 ≠ 8`). Дүрэм бүр нөгөөгийн оролтыг үүсгэж болох тул тогтворжтол давтана.

### 3.2 Харьцуулах хэлбэрүүд

Нэр бүр screening бүрт НЭГ удаа бэлтгэгдэж (`prepareName`) хэд хэдэн **хэлбэр**-тэй, гурван **багц**-д хуваагдана. Нэр хос бүрийн оноо = ижил багц доторх хэлбэр хосуудын **хамгийн өндөр оноо**; багц бүрийг зөвхөн ижил багцтай нь харьцуулна (нэг нь нөгөөгөө орлохгүй).

**Багц 0 — үндсэн:**
- **Үндсэн** хэлбэр — §3.1.
- **Паспортын хэлбэр** — нэрэнд `ө` байвал. Монгол паспорт `Ө`-г `U` гэж бичдэг (`Өлзий` → үндсэн `olzi`, паспорт `ulzi`; §3.1-ийн fold-оор давхар `ii` нэг болсон). Jaro-Winkler-ийн тэсвэрлэлтэд найдахгүй: богино токен, хоёр `ө`-тэй нэрэнд ч яг таарна.
- **Дүрсээр ижил (confusable) хэлбэр** — нэг үгэнд латин БА кирилл үсэг хоёулаа байвал (`Рaуpаl`): кирилл үсгийг латин дүрстэй нь (`р→p, н→h, с→c, х→x, у→y, в→b, к→k, м→m, т→t, а→a, е→e, о→o, і→i …`) сольж, үлдсэнийг ердийн translit-ээр хөрвүүлнэ. Дуудлагаар хөрвүүлбэл (`р→r`, `с→s`) ийм нэр оноо алддаг. Зөвхөн холимог үгэнд (§10).
- **ААН** (`LEGAL_ENTITY` субъект, UN-ийн `ENTITY` бүртгэл): эхлээд `normalizeEntityName` — цэгтэй үсгийн цувааг залгана (`L.L.C.`, `L. L. C.`, `F.Z.E.`, `S.A.R.L.`, `Х.Х.К` → `LLC`, `FZE`, `SARL`, `ХХК`), `ООО`/`OOO`-г `LLC` болгоно (орос хэлний ООО = LLC). Дараа нь хуулийн хэлбэрийн үгийг хоёр талаас хасна — `ХХК, ХК, ТӨҮГ, ОНӨААТҮГ, ББСБ, LLC, LLP, Ltd, Limited, Co, Company, Inc, Incorporated, Corp, Corporation, JSC, OJSC, CJSC, PJSC, PLC, GmbH, FZE, FZC, FZCO, Pvt, SARL, SRL, ЗАО, ОАО` (нормчилсон токеноор тулгана). Хасаад юу ч үлдэхгүй бол анхны нэрийг хэвээр үлдээнэ. Нэрийн утга агуулсан үгс (`Trading`, `Holdings`, `Bank` …) жагсаалтад байхгүй; 1–2 үсэгт нормчигдох `S.A.`, `B.V.`, `AG` зэрэг орхигдсон.

**Багц 1 — эгшгийн хувилбар.** Араб нэрийн `o/u` ба `e/a` бичлэгийн зөрүү (`Mohammed ~ Muhammad`, `Omar ~ Umar`, `Hossein ~ Hussein`): ЗӨВХӨН үндсэн хэлбэрийн (хуулийн хэлбэр хассан) токен бүрт `o→u`, `e→a` хийж давхар үсгийг дахин нэгтгэнэ (`mohammed` → `muhamad`). Паспорт, confusable хэлбэрт хийхгүй (хэлбэрийн тоо квадратаар өснө). Өөрчлөгдөх үсэг байхгүй бол багц нь багц 0-тэй ижил массив (дахин тооцохгүй). Оноо `VOWEL_SCORE_CAP` = **0.93**-аас дээшгүй (§3.3).

**Багц 2 — хуулийн хэлбэр хасаагүй** (зөвхөн ААН-д, хасалт ядаж нэг токеныг өөрчилсөн үед). Хассан нь хасаагүйгээс бага recall өгч болохгүй тул **хассан БА хасаагүй хоёулангийн max** авна (`Golomt ХХК ~ Gmlomt ХХК` мэт богино нэрэнд нийтлэг хуулийн хэлбэр оноог өсгөдөг).

### 3.3 Оноо (0..1)

Хэлбэр хос бүрт:

1. Нормчилсон хэлбэр яг тэнцүү → 1.
2. **Токений оноо.** Токен хос бүрийг Jaro-Winkler-ээр (prefix scale 0.1, prefix ≤ 4, boost зөвхөн Jaro > 0.7 үед) оноож, ≥ **0.80** (`PAIR_MIN`) хосыг шунахай аргаар 1:1 оноон, урт жингээр (хосын жин = хоёр токены урт дотроос их нь) дундажлана. Хосгүй токен (аль ч талын) өөрийн уртаар хуваагчид орж оноог бууруулна: `Bat Erdene` ↔ `Bat Erdene Ganbold` нь тохирол **биш** (0.5625). Дараалал хамаарахгүй. Хямд шүүлтүүр `mayMatch` (нийтлэг тэмдэгтгүй, эсвэл богино токены урт × 10 ≤ урт токены урт хосыг JW-д оруулахгүй) ба JW-ийн эрт зогсолт (`floor`-д хүрэхгүй нь тодорхой хосыг дунд нь тасалж 0 буцаана) нь ямар ч хүчинтэй хосыг алддаггүй. **Цифр токен:** бүх-цифртэй токенууд (`88`, `2024`, `1`) хоёр талд байгаад олонлог нь зөрвөл (`Group 1 ≠ Group 2`, `88 ≠ 8`) хосын оноо `reviewThreshold − 0.0001` (анхдагч 0.8799)-аас дээш гарахгүй: engine нь энэ cap-ийг бодлогын босгоос тооцож дамжуулдаг (matching номын сангийн анхдагч `DIGIT_CONFLICT_CAP` = 0.5). Нэг талд л цифр токен байвал cap үйлчлэхгүй (хосгүй токен хуваагчид орно).
3. **Залгасан хэлбэр** — зөвхөн үгийн ХИЛ ХЯЗГААР зөрсөн нэр (`Abdul Rahman ~ Abdulrahman`, `Бат-Эрдэнэ ~ Батэрдэнэ`). Хязгаарласан дүрэм:
   - хоёр талын эхлэл ба төгсгөлийн ЯГ тэнцүү токенуудыг хасахад үлдсэн хэсэг хоёр талдаа хоосон биш, ядаж нэг талд нь 2+ токен байх; үлдсэн хэсгээс гадуурх токен бүр ЯГ таарна (нэг талын нэг бүтэн токен өөр — `Malik bin Majid` ~ `Nasir bin Majid` — хил хязгаарын зөрүү биш, токений оноо хариуцна); үлдсэн хэсэгт инициал байвал нөгөө тал нь НЭГ үг байх ёстой (`J R R ~ JRR`);
   - токенуудыг зайгүй залгаж дахин fold хийсэн хэлбэрүүдийн засварын зай (Levenshtein) **дээд тал нь 1 тэмдэгт** (`JOINED_MAX_EDITS`); аль нэг талд инициал (нэг үсэгт токен) байвал **0** засвар (`Б.Ганбаатар ~ Д.Ганбаатар` өөр хүн, 0.80);
   - ижилсэл `1 − зай / урт` **≥ 0.80** (`JOINED_MIN`); хоёр талын цифр ялгаатай бол (`88 ≠ 99`) 0.
   Jaro-Winkler биш: prefix boost нь хэсэгчилсэн давхцлыг (`baterdene` ~ `baterdeneganbold`) хэт өсгөнө.
4. **Эргэлт** — овог/нэрийн дараалал, хил хязгаар хоёулаа зөрсөн нэр. Хоёр талд 2+ үг, инициалгүй байхад токенуудыг цикл дарааллаар эргүүлж залгасан хэлбэрүүдийн аль нэг яг тэнцүү бол таарна: `Ганболд Батэрдэнэ` ~ `Bat Erdene Ganbold`. Зөвхөн ЯГ тэнцүү үсгийн дарааллыг хүлээн авна (үсгийн зөрүүтэй бол §10); инициал эргэлтэд оролцохгүй.

Залгасан хэлбэр ба эргэлт нь нормчилсон нэр ижил биш тул хэзээ ч 1 болохгүй:

| Тохирлын зам | Оноо дээд тал |
| --- | --- |
| Нормчилсон хэлбэр (эсвэл токены олонлог, дарааллаас үл хамааран) яг тэнцүү | 1 → `NAME_EXACT` |
| Залгасан хэлбэр, эргэлт (`VARIANT_SCORE_CAP`) | 0.97 (`strongThreshold` 0.95-аас дээш) |
| Эгшгийн хувилбар (`VOWEL_SCORE_CAP`) | 0.93 (`reviewThreshold` 0.88-аас дээш, `strongThreshold`-оос доош) |
| Цифр токен зөрсөн | `reviewThreshold − 0.0001` |

Эгшгийн хувилбарын cap нь `Mohammed ~ Muhammad` мэт маш олон хүний нэрийн бичлэгийн зөрүүг review-д оруулах боловч төрсөн он зөрсөн / `LOW_ALIAS` үед (`strongThreshold` шаардана) нийтлэг нэрийн хуурамч hit-ийг хаана.

Хэлбэр хосын оноо = `max(токений оноо, залгасан хэлбэр/эргэлтийн оноо)`; нэрийн оноо = бүх багц, бүх хэлбэр, бүх нэр (овог+нэр, alias) хосын хамгийн өндөр нь.

**Бөөрөнхийлөлт.** Hit-ийн оноо 4 орон хүртэл бөөрөнхийлөгдөнө (`aml_hit.score` нь `Decimal(5,4)`) — босго шалгахаас ӨМНӨ, ингэснээр `POST /aml/screen` ба дараагийн уншилт ижил утга өгнө. 1-ээс бага бодит оноо `1.0000` болохгүй (0.9999 хүртэл хязгаарлана), тиймээс `NAME_EXACT` нь оноо яг 1, өөрөөр хэлбэл дор хаяж нэг хэлбэр хосын нормчилсон нэр (эсвэл токенуудын олонлог) тэнцүү гэсэн үг. Залгасан хэлбэр, эргэлт, эгшгийн хувилбараар таарсан нь `NAME_FUZZY`.

### 3.4 Hit болгох

1. `score ≥ reviewThreshold` (анхдагч 0.88) бол hit. Чанар муутай alias (`LOW_ALIAS`) ба төрсөн он зөрсөн үед `strongThreshold` (0.95) шаардана. Төрсөн оныг зөвхөн хувь хүний бүртгэлд, зөвхөн оноор нь харьцуулна; аль нэг тал нь тодорхойгүй бол зөрүү гэж үзэхгүй.
2. Регистр UN бүртгэлийн бичиг баримтын дугаартай таарвал (хоёр талыг `normalizeRegisterNo`-оор) нэрнээс үл хамааран `REGISTER_EXACT` (оноо 1). Нөхцөл: субъектын нормчилсон регистр хоосон биш. **Улсын шүүлтүүр зөвхөн Монгол хэлбэрийн регистрт** (нормчилсон: хувь хүн = 2 кирилл үсэг + 8 цифр, ААН = яг 7 цифр) үйлчилнэ: тэр үед ISO alpha-2 улс заасан бичиг баримт нь субъектын `countries` (анхдагч `['MN']`)-д байх ёстой; улсгүй (UN өгөгдөлд олонтаа) эсвэл ISO биш утгатай бичиг баримтыг тайлбарлах боломжгүй тул харьцуулна (recall). Бусад хэлбэрийн дугаар (жнь гадаад паспорт `FX0012345`) улсаар шүүгдэхгүй, бүх бичиг баримттай харьцуулагдана: service нь `countries` хоосон үед `['MN']` болгон нөхдөг (origination-д иргэншил байхгүй тул дуудагч ихэвчлэн дамжуулж чадахгүй) тул engine "улс тодорхойгүй"-г "Монгол"-оос ялгаж чадахгүй, шүүвэл гадаадын иргэний UN баримт хэзээ ч таарахгүй. Ингэснээр гадаад паспортын 7–8 цифр монгол регистртэй мөргөлдөхгүй. `matchedValue` нь масклагдсан регистр. Нэг UN бүртгэлд нэг hit: `REGISTER_EXACT` нь нэрийн тохиролоос давамгайлах ба нэрийн нотолгоо `details`-д хэвээр үлдэнэ.
3. Хувь хүн ↔ байгууллага төрөл таарахгүй бол нэрээр тулгахгүй (регистрээр тулгана).
4. `FATF`: `subject.countries`-ийг (хоосон бол service `['MN']` болгоно) snapshot-ийн улсын кодтой тулгана; `CALL_FOR_ACTION` нь `blockOnFatfCallForAction` үед `BLOCKING`, бусад нь `WARNING`.
5. `INTERNAL_BLACKLIST`: регистрийн hash-ээр `blacklist_projection`-ны идэвхтэй бүртгэл; `matchType=REGISTER_EXACT`, `listVersion='live'`, `entryRef` = `origination.blacklist.id`, `matchedValue` = null, `severity` нь `blockOnInternalBlacklist`-ээс (анхдагч `WARNING`, BR-9).
6. Hit бүр `details.evidenceDigest` (нотолгооны хуруун мөр) авна: `sha256(canonicalJson({list, entryRef, matchType, severity, score, details}))`. Жагсаалтын ХУВИЛБАР, мөн service-ийн тэмдэглэгээ (`evidenceDigest`, `carriedOverFrom`, `reopenedBecause`) орохгүй — нотолгоо өөрчлөгдөөгүй бол хувилбар солигдсон ч ижил. §5-ын шийдвэр дамжуулалтад хэрэглэгдэнэ.

### 3.5 Регистрийн дугаар

`normalizeRegisterNo` (`@los/database`), дарааллаар:

1. `\p{Cf}` (ZWSP, ZWJ, soft hyphen, bidi) тэмдэгт устгана.
2. NFKC (fullwidth цифр; `Й`, `Ё` нэг тэмдэгт болж нийлнэ) → том үсэг → дахин NFKC.
3. Үсэг (`\p{L}`) эсвэл аравтын цифр (`\p{Nd}`) биш бүгдийг устгана: зай, бүх төрлийн зураас, `_ . / ,`, mark, modifier letter (`\p{Lm}`). Mark нь NFKC-ийн дараа л устна, тэгэхгүй бол `Й → И` болно.
4. Бусад бичгийн аравтын цифр (араб-энэтхэг, деванагари …) → ASCII `0–9`.
5. Кирилл дүрстэй латин үсгийг кирилл болгоно: `A B E K M H O P C T Y X → А В Е К М Н О Р С Т У Х`; кирилл `Ү → У` (латин `Y`, кирилл `Ү`, `У` гурав нэг дугаар болно — DECISIONS).

Үр дүн нь зөвхөн том үсэг ба ASCII цифр, idempotent. `Ө` нь `О` руу нэгтгэгдэхгүй (§10).

**Шалгалт** (`AmlSubject.registerNo`, `isUsableRegisterNo`): `trim`-ийн дараа 1–32 тэмдэгт БА нормчилсны дараа дор хаяж 1, дээд тал нь 32 үсэг/цифр; үгүй бол 400. `@los/contracts` нь `@los/database`-г импортлохгүй тул дүрмийг давхар хэрэгжүүлсэн; kyc-ийн `register-contract-parity.test.ts` хоёр хэрэгжүүлэлтийг тулгана.

**Маск** (`maskRegisterNoStrict` — `@los/database` `register-no.ts`; `registerNoMasked`, `REGISTER_EXACT`-ийн `matchedValue`): n = нормчилсон урт. `n ≤ 6` бол бүгдийг `*`. Үгүй бол зөвхөн сүүлийн `min(4, ⌊n/3⌋)` тэмдэгтийг ил гаргаж, угтвар үсгийг харуулахгүй (n = 7–8 → 2, 9–11 → 3, ≥ 12 → 4). Урт нь нормчилсон утгатай ижил: `УБ12345678` → `*******678`, `1234567` → `*****67`. Суурийн `maskRegisterNo` (`crypto.ts`, `УБ****5678` хэлбэр; богино дугаарыг бүхэлд нь ил гаргаж болно) өөрчлөгдөөгүй, энэ модуль ашигладаггүй.

**Hash** (`hashRegisterNo`): `blindIndex(normalizeRegisterNo(x))` (`@los/database` `crypto.ts`) = `HMAC-SHA256(DATA_INDEX_KEY, нормчилсон регистр)`, 64 жижиг hex. `PII_HASH_KEY` байхгүй болсон. Түлхүүр байхгүй/буруу бол алдаа (screen 500, хар жагсаалтын бичилт/хайлт 500; CSV/JSON импортод мөр бүр `internal error`-той 200 — origination README).

**Шифр.** Регистр `encryptedField(normalizeRegisterNo(x), aad)` — AES-256-GCM (`v1.<keyId>.<iv>.<tag>.<ciphertext>`, түлхүүр `DATA_ENCRYPTION_KEY[S]`). `aad` = `aml_check.register_no` (kyc), `blacklist.register_no` (origination): шифртекст өөр баганад хуулагдвал тайлагдахгүй.

### 3.6 Оролтын хязгаар ба гүйцэтгэл

- Нэр (`lastName`, `firstName`, alias тус бүр) ≤ **12** үг (`MAX_NAME_TOKENS`), бүх нэр нийлээд ≤ **48** үг (`MAX_SUBJECT_NAME_TOKENS`) — Jaro-Winkler токен хос бүрт ажилладаг тул DoS-оос хамгаална. 12 үгэнд араб угсаа залгамжлалтай нэр (`Sheikh Hamad bin Khalifa bin Hamad bin Abdullah bin Jassim al-Thani` = 12), испани/герман овог-угтвартай нэр багтана. Үг тоолох: NFKC → зай, зураас, `_ . , / \`-ээр таслаад үсэг/цифргүй хэсгийг тоолохгүй. Хэтэрвэл 400. Бусад хязгаар: `lastName` ≤ 120, `firstName` 1–200, `aliases` ≤ 20 (тус бүр 1–200), `countries` ≤ 10 (ISO alpha-2, том үсэг болгоно), `orgId`, `customerId`, `applicationId` ≤ **128** (`AML_ID_MAX_LENGTH`; индекстэй багана тул хязгааргүй бол btree-ийн мөрийн хэмжээнээс хэтэрч 500 болдог).
- Нормчилсны дараа хоосон болдог нэр (`---`, `()`, үл үзэгдэх тэмдэгт, emoji) бүх хувилбараараа хоосон бол нэрээр тулгах боломжгүй тул `400 Subject has no name that can be screened` — "CLEAR" гэж хэзээ ч хариулахгүй (`hasScreenableName`).
- Субъектын нэрсийг screening бүрт нэг удаа бэлтгэнэ; UN бүртгэлийн нэрийн бэлтгэлийг snapshot-той хамт (WeakMap) cache-лэнэ; нэг нэрийн хэлбэрүүд ижил токен (код цэгийн массив, тэмдэгтийн mask)-оо хуваалцана; хоёр талдаа ижил багцыг дахин тооцохгүй. Токен хос тутмын Jaro-Winkler-ийн утгыг cache-лэхгүй.

## 4. Бодлого (`AmlPolicy`, анхдагч утга `DEFAULT_AML_POLICY`)

| Талбар | Анхдагч | Утга |
| --- | --- | --- |
| `reviewThreshold` | 0.88 | Нэрийн ижилсэл энээс дээш бол hit |
| `strongThreshold` | 0.95 | LOW_ALIAS / төрсөн он зөрсөн үед шаардах босго |
| `blockOnSanctionsHit` | true | UN тохирол шийдвэрлэгдтэл хүсэлтийг хаах эсэх |
| `blockOnFatfCallForAction` | false | FATF "хар" жагсаалтын улс хаах эсэх (өгөгдмөлөөр EDD анхааруулга) |
| `blockOnInternalBlacklist` | false | **BR-9**: дотоод хар жагсаалт зөвхөн анхааруулга |
| `requireSeparateReviewer` | true | Шалгалтыг эхлүүлсэн хүн тухайн шалгалтын hit-ийг ямар ч шийдвэрээр (`CONFIRMED` ч, `FALSE_POSITIVE` ч) шийдвэрлэж болохгүй (403) |
| `maxStaleListHours` | 72 | Жагсаалт татаж чадахгүй үед хуучин cache-ийг хэр удаан ашиглах |
| `risk.weights.*`, `risk.mediumFrom/highFrom` | 25/10/15/40/20/60/100, 30/60 | Эрсдэлийн оноо |

Бодлого зөвхөн `strongThreshold ≥ reviewThreshold` ба `risk.mediumFrom < risk.highFrom` үед хүчинтэй (үгүй бол zod няцаана): эс бөгөөс "хатуу" босго энгийн босгоосоо сул болж дүрэм урвуу ажиллана.

Эрсдэлийн оноо (`@los/calc` `amlRisk`): PEP, холбоотой этгээд, FATF (`CALL_FOR_ACTION` нь `INCREASED_MONITORING`-оос давамгайлна), дотоод хар жагсаалт, UN (`POSSIBLE` эсвэл `CONFIRMED`)-ийн жингийн нийлбэр, дээд тал нь 100. `FALSE_POSITIVE` hit тооцогдохгүй; `CONFIRMED` UN тохирол бодлогын утгаас үл хамааран үргэлж `HIGH`.

Одоогоор бодлого org бүрт `StaticAmlPolicyProvider`-аас (анхдагч) ирнэ. `origination.settings`-ийн `SettingsChanged` projection бэлэн болоход `AmlPolicyProvider`-ийг сольно.

## 5. Төлөв ба шийдвэрлэх урсгал

| `ScreeningStatus` | Утга | `blocking` |
| --- | --- | --- |
| `CLEAR` | Тохирол алга | false |
| `WARNING` | Зөвхөн анхааруулгын түвшний hit (дотоод хар жагсаалт, FATF) | false |
| `REVIEW_REQUIRED` | Шийдвэрлэгдээгүй BLOCKING hit | **true** |
| `CONFIRMED_MATCH` | BLOCKING hit баталгаажсан | **true** |
| `CLEARED_AFTER_REVIEW` | Бүх hit худал тохирол гэж шийдвэрлэгдсэн | false |

Төлөв нь hit-үүдээс дараах давамгайллаар үүснэ: BLOCKING+`CONFIRMED` байвал `CONFIRMED_MATCH`; үгүй бол BLOCKING+`OPEN` байвал `REVIEW_REQUIRED`; үгүй бол `FALSE_POSITIVE` биш hit байвал `WARNING`; үгүй бол (бүгд `FALSE_POSITIVE`) `CLEARED_AFTER_REVIEW`; hit байхгүй бол `CLEAR`.

- Hit-ийг `ADMIN` эсвэл `APPROVER` шийднэ: `POST /api/aml/hits/:id/review` `{decision: CONFIRMED|FALSE_POSITIVE, comment}` — тайлбар заавал (trim-ийн дараа 5–2000 тэмдэгт). Алдаа: 404 (олдохгүй, өөр org, uuid биш), 409 (аль хэдийн шийдвэрлэгдсэн, эсвэл screening-ийг шинэ шалгалт сольсон — доорх "Хуучирсан шалгалт"), 403 (дүр, эсвэл доорх segregation of duties).
- Шийдвэр **өөрчлөгдөхгүй** (`CONFIRMED`-ийг `FALSE_POSITIVE` болгох, эсрэгээр нь ч үгүй — 409). Хоёр хүн нэг hit-ийг зэрэг шийдвэрлэвэл нэгдүгээр нь ялна (compare-and-set), хоёр дахь нь 409.
- **Шийдвэрлэлт атомик.** Нэг DB транзакцид: харилцагчийн (org, `customerId`) advisory түгжээ (`pg_advisory_xact_lock`) → screening-ийн мөрийг түгжинэ (`SELECT … FOR UPDATE`) → screening одоо ч харилцагчийн сүүлийнх эсэхийг шалгана → hit-ийг `status=OPEN` нөхцөлөөр compare-and-set → screening-ийн БҮХ hit-ийг дахин уншина → төлөв, `blocking`, эрсдэлийг DB-ийн одоогийн төлвөөс гаргана → screening шинэчилнэ → `AmlHitReviewed`-ийг outbox-д бичнэ. Иймд нэг screening-ийн өөр өөр hit-ийг хоёр хүн зэрэг шийдвэрлэхэд эцсийн төлөв хоёр шийдвэрийг хоёуланг нь тусгана (хуучирсан snapshot-оос бодсон нэгтгэл нөгөөгийнхөө үр дүнг дарахгүй). Түгжээний дараалал (харилцагч → screening мөр) `saveScreening`-д мөн ижил.
- **Хуучирсан (superseded) шалгалт.** Харилцагчийн (org + `customerId`) `screened_at`, `id` буурахаар хамгийн сүүлийн шалгалт л "одоогийнх"; өмнөхүүд нь superseded (тусдаа багана байхгүй, эрэмбээр тодорхойлогдоно). Superseded шалгалтын hit `GET /aml/hits` дараалалд (нийт тоонд ч) орохгүй, шийдвэрлэвэл `409 Screening is superseded by a newer one; review the hits of the latest screening`. Шалгалт service дээр ба repository транзакц дотор түгжээтэйгээр давтан хийгдэнэ (review ба шинэ шалгалтын уралдаан): эс бөгөөс хуучин screening-ийн hit-ийг цэвэрлэхэд `AmlHitReviewed {blocking:false}` гарч, блоклосон харилцагчийг consumer чөлөөлчихнө.
- **Segregation of duties.** `requireSeparateReviewer=true` үед `screening.screenedBy` нь шийдвэрлэгчтэй ижил бол шийдвэр ямар ч (`CONFIRMED` ч) байсан 403. `rescreen` нь анхны шалгалтыг эхлүүлсэн хүнийг (`screenedBy`) `LIST_UPDATE` шалгалтад хэвээр үлдээнэ — rescreen хийсэн admin нь зөвхөн event-ийн `actorId`; ингэснээр maker өөрийн hit-ийг rescreen-ээр дамжуулан цэвэрлэж чадахгүй.
- **Харилцагч тутамд цуваа шалгалт.** `screen` нь өмнөх сүүлийн шалгалтыг уншиж (guard, carry-over), жагсаалт татаж engine ажиллуулаад хадгалахдаа `saveScreening` нь (org, `customerId`)-ийн advisory түгжээ аваад, өмнөх шалгалт одоо ч сүүлийнх (`expectedPreviousId`) эсэхийг ЭНЭ транзакц дотор шалгана. Зэрэгцээ шалгалт орчихсон бол `ScreeningRaceError`: service өмнөх төлвөө дахин уншиж guard + carry-over-оо шинээр хийнэ (жагсаалт татах, engine-ийг дахин ажиллуулахгүй), нийт **3 оролдлого**, бүтэхгүй бол `409 Another screening of this customer was saved at the same time (concurrent screening, retry)`. Шинэ шалгалтын `screenedAt` нь өмнөхөөсөө дор хаяж 1 мс хожуу. Иймд хоёр зэрэг шалгалтын нэг нь нөгөөгөө блоклосон төлвөөс "цэвэр" болгон дарж чадахгүй.
- **Өмнөх шийдвэрийг дамжуулах (carry-over).** Харилцагчийн ӨМНӨХ СҮҮЛИЙН шалгалт (зөвхөн хамгийн сүүлийнх, гинжин) ижил `registerNoHash`-тай үед шинэ шалгалтын hit бүрийг тэр шалгалтын ШИЙДВЭРЛЭГДСЭН hit-тэй `(list, entryRef)`-ээр тулгана:
  - **`CONFIRMED`** дамжина — `matchType`, нотолгоо, субъектын нэр өөрчлөгдсөн ч (баталгаажсан хоригийг нэрийн тохирлын төрөл солигдсоны улмаас ганц reviewer цэвэрлэж болохгүй). Ижил `(list, entryRef)`-д `CONFIRMED` ба `FALSE_POSITIVE` хоёулаа байвал `CONFIRMED` давамгайлна.
  - **`FALSE_POSITIVE`** дамжих нь субъектын identity түлхүүр (доорх), `matchType`, `details.evidenceDigest` ГУРВУУЛАА өмнөхтэй тэнцүү үед л. Өөрөөр (төрсөн он таарсан/зөрсөн, FATF ангилал өссөн, оноо, нэр, бүртгэлийн агуулга өөрчлөгдсөн гэх мэт) шинэ hit `OPEN` хэвээр үлдэж `details.reopenedBecause = 'EVIDENCE_CHANGED'` авна — дахин хянуулна.

  Дамжсан hit `status`, `reviewedBy`, `reviewedAt` (анхны цаг, дахин тамгалахгүй), `reviewComment`-ийг өвлөж, `details.carriedOverFrom`-д өмнөх hit-ийн id-г авна. Screening-ийн төлөв, `blocking`, эрсдэл дамжсан hit-үүдээс гарах тул `CONFIRMED` hit блоклосон хэвээр, буцаах боломжгүй (шийдвэрлэх оролдлого 409). Шийдвэргүй (`OPEN`) hit, өөр регистр (`registerNoHash`)-тэй шалгалт дамжихгүй. Жагсаалтын ХУВИЛБАР `evidenceDigest`-д ороогүй тул нотолгоо өөрчлөгдөөгүй бол хувилбар солигдоход цэвэрлэгдсэн хуурамч тохирол дахин нээгдэхгүй. Дамжуулалт зөвхөн шинэ шалгалтад hit гарсан үед хийгдэнэ — бүртгэл жагсаалтаас хасагдсан эсвэл тохирохоо больсон бол өмнөх шийдвэр (`CONFIRMED` ч) алга болно (§10).
- **Блоклосон шалгалтыг өөр субъектоор дарахгүй.** Харилцагчийн (org + `customerId`) сүүлийн шалгалт блоклосон (`REVIEW_REQUIRED` / `CONFIRMED_MATCH`) бөгөөд шинэ хүсэлтийн `registerNoHash` ЭСВЭЛ **identity түлхүүр** ялгаатай бол `409 Conflict` (`The customer has a blocking screening for a different identity; resolve the open hits first`), юу ч хадгалагдахгүй. Identity түлхүүр (`subject-identity.ts`) = `subjectType`, `lastName`, `firstName`, `aliases` (эрэмбэлсэн, давхардалгүй), `birthDate`, `countries` (эрэмбэлсэн); текст бүр NFKC → жижиг үсэг → зай нэгтгэсэн. `isPep`, `isRelatedParty` ороогүй (эрсдэлийн шинж, хэн гэдгийг биш). Ижил субъектын дахин шалгалт, rescreen, блоклоогүй сүүлийн шалгалт зөвшөөрөгдөнө. Хамгаалалт `customerId` тутмын (§10).
- `blocking=true` үед origination хүсэлтийг үргэлжлүүлэхгүй (G1 хаалт) — энэ холбоог application сервис хэрэгжүүлнэ.

## 6. Найдвартай байдал

- **Fail closed**: жагсаалтыг уншиж чадахгүй бол хэзээ ч "цэвэр" гэж хариулахгүй. Cache байвал `maxStaleListHours` хүртэл ашиглаад `listVersions`-д `+stale` дагавар тавина (жнь `2026-10+stale`); үгүй бол `503`. Хоосон snapshot, хувилбаргүй snapshot-ыг алдаа гэж үзнэ.
- **Cache, timeout, backoff.** Cache нь дуудлагаар шинэчлэгдэнэ (тусдаа timer байхгүй): `AML_LIST_REFRESH_MINUTES` (анхдагч 360) өнгөрсөн, эсвэл сүүлийн таталт алдаатай бол дараагийн дуудлага дахин татна. Cache нь процесс тутамд. Таталт `fetchTimeoutMs`-ээр (`WatchlistOptions`, анхдагч **15000 мс**, CLAUDE.md §3.1) хязгаарлагдана: хугацаа хэтэрвэл `fetchSnapshot(signal)`-ийн `AbortSignal` цуцлагдаж алдаа гэж үзээд ≤ `maxStaleListHours` cache руу шилжинэ, cache байхгүй бол 503. Нэгэн зэрэг дуудсан бүгд нэг таталтыг хуваалцана (single-flight) — өлгөөтэй таталт дуудагчдыг барьж үлдэхгүй, цуцалсан клиентийн хожим буцаасан үр дүн cache-ийг дарахгүй.
  - **Backoff**: таталт амжилтгүй (алдаа, timeout, доорх truncation) болсны дараа `retryBackoffMs` (анхдагч **30000 мс**; 0 → хаалтгүй) хугацаанд screening-ийн замд ШИНЭ таталт эхлүүлэхгүй: ашиглах боломжтой хуучин cache-ийг (≤ `maxStaleListHours`) даруй `+stale` тэмдэгтэй өгнө, байхгүй бол санасан алдаагаар даруй 503. Хугацаа дуусмагц дараагийн дуудлага дахин оролдоно. Иймд тасралтын үед `fetchTimeoutMs` (15 с) хүртэл хүлээх нь жагсаалт тутамд ойролцоогоор 30 секундэд нэг дуудлага. `POST /aml/lists/refresh` (албадан) backoff-д хамаарахгүй.
  - **Хэсэгчилсэн таталтын хамгаалалт**: өмнөх snapshot ≥ 20 бичилттэй (`TRUNCATION_GUARD_MIN_ENTRIES`) бөгөөд шинэ snapshot-ийн бичилтийн тоо түүний `minSnapshotRatio` (анхдагч **0.5**; 0 → шалгахгүй)-оос БАГА бол таталт амжилтгүй гэж үзнэ (өмнөх cache хэвээр, degraded). Cache хоосон (процесс дөнгөж асаасан) үед харьцуулах зүйлгүй.
- **Дахин шалгалт**: `POST /api/aml/rescreen` (ADMIN, `{limit}` 1–500, анхдагч 50). Харилцагч бүрийн ХАМГИЙН СҮҮЛИЙН шалгалтыг `UN_SC`, `FATF`-ийн одоогийн хувилбартай (`listVersions`-оор) харьцуулж, зөрсөнийг хамгийн хуучнаас нь эхлэн `limit` хүртэл `LIST_UPDATE` trigger-ээр дахин шалгана. Хариу `{checked, rescreened, failed, skipped}`. Регистрийг шифрээс тайлж, одоогийн `DATA_INDEX_KEY`-ээр дахин hash хийнэ. Шийдвэр өвлөгдөнө, `screenedBy` хэвээр (§5).
  - `skipped`: сонгосноос хойш харилцагчийн сүүлийн шалгалт солигдсон (жнь үүний завсар шинэ нэрээр шалгагдсан) — хуучирсан субъектыг дахин шалгахгүй, шинэ шалгалтыг дарахгүй. Шалгалтыг `screen` нь өмнөх шалгалт одоо ч сүүлийнх эсэхээр (`supersedes`) түгжээтэй транзакц дотор давтан хийдэг.
  - `failed`: нэг харилцагчийн алдаа (шифр тайлах, §5-ын 409, DB) `failed`-д тоологдож бусдыг зогсоохгүй. Алдаа бүр ERROR түвшинд `rescreen failed: error=<ангийн нэр> code=<код> customerId=<id> correlationId=<id>` гэж логлогдоно (мессеж, нэр, регистр орохгүй).
  - **`UN_SC` эсвэл `FATF`-ийг уншиж чадахгүй бөгөөд ашиглах cache байхгүй бол БҮХ хүсэлт `503`** (одоогийн хувилбарыг давталтаас өмнө авдаг тул харилцагч тутмын `failed` биш); давталтын дундуур унасан нь `failed`.
  - Cron/BullMQ-ээр дуудах wiring хийгдээгүй (одоогоор ADMIN гараар).
- **`+stale` ба дахин шалгалтын давталт.** Rescreen-ий "одоогийн хувилбар" нь `screen()`-тэй ижил дүрмээр `+stale` дагавар авна. Тиймээс доройтсон (degraded) төлөв өөрчлөгдөөгүй байхад ижил харилцагч дахин сонгогдохгүй. Үр дагавар: жагсаалт fresh → degraded болоход харилцагч бүр нэг удаа (`+stale` тэмдэгтэй) дахин шалгагдана; дараа нь fresh болтол дахин шалгагдахгүй, fresh болоход (дагавар алга болно) нэг удаа дахин шалгагдана.
- **Дотоод хар жагсаалт rescreen-д оролцохгүй.** `INTERNAL_BLACKLIST` нь `'live'` тогтмол хувилбартай тул rescreen-ий хувилбар харьцуулалтад ордоггүй: хар жагсаалтад дараа нь нэмэгдсэн харилцагчийг rescreen **өөрөө олохгүй**, тэр нь дараагийн `POST /aml/screen` хүртэл өмнөх үр дүнтэй (мөн §10).
- **Регистр ба PII.** Регистр AES-256-GCM-ээр шифрлэгдэж (`register_no_encrypted`, нормчилсон хэлбэрээр, §3.5) хадгалагдана; lookup-д `HMAC-SHA256(DATA_INDEX_KEY, нормчилсон регистр)` (§3.5). `subject_json` snapshot регистр агуулахгүй; лог, event, hit-ийн нотолгоонд plain регистр орохгүй — зөвхөн масклагдсан хэлбэр.

## 7. API

kyc (`/api`). Хүсэлт эхлээд глобал `ContextAuthGuard`-ыг, дараа нь модулийн `AmlAccessGuard`-ыг давна. Толгой: `INTERNAL_AUTH_SECRET` тохируулсан бол `X-Internal-Token` (gateway нэмнэ; үгүй/буруу бол 401 `INVALID_INTERNAL_TOKEN`), `X-User-Id` заавал (үгүй бол 401), `X-Roles` (үл мэдэгдэх дүрийг тооцохгүй), `X-Org-Id` эсвэл `DEFAULT_ORG_ID` (аль нь ч үгүй бол 401 `MISSING_ORG`; модулийн guard-ийн 400 нь глобал guard-гүй тестэд л гарна), `X-Correlation-Id` (үгүй бол uuid үүснэ). Gateway-аар `/api/kyc/aml/…` гэж дамжина (§10).

| Метод, зам | Дүр | Тайлбар |
| --- | --- | --- |
| `POST /aml/screen` | дурын нэвтэрсэн | 201. `AmlScreenRequest` → `AmlScreeningResult` |
| `GET /aml/screenings/:id`, `GET /aml/customers/:customerId/latest` | дурын нэвтэрсэн | Түүх / wizard-ийн "Лавлагаа" алхам |
| `GET /aml/hits?status=OPEN&list=&limit=&offset=` | ADMIN, APPROVER | Шийдвэрлэх дараалал: харилцагч тутмын ОДООГИЙН (сүүлийн) шалгалтын hit л. `limit` 1–100 (анхдагч 20), `offset` 0–1 000 000 |
| `POST /aml/hits/:id/review` | ADMIN, APPROVER | 200. Шийдвэрлэх (§5); хариу нь хадгалагдсан screening |
| `GET /aml/lists`, `POST /aml/lists/refresh` | ADMIN, APPROVER / ADMIN | Жагсаалтын хувилбар (`UN_SC`, `FATF`), шинэчлэх (албадан, backoff-д хамаарахгүй) |
| `POST /aml/rescreen` | ADMIN | Хуучирсан шалгалтуудыг дахин хийх (§6). Хариу `{checked, rescreened, failed, skipped}`; жагсаалт унасан бол 503 |

`POST /aml/screen`-ий алдаа:

| Код | Нөхцөл |
| --- | --- |
| 400 | Схем (регистр §3.5, нэрийн үгийн хязгаар §3.6, улсын код, огноо …); бүх нэр нормчлогдоод хоосон; U+0000 эсвэл дан surrogate |
| 403 | Body-ийн `orgId` нь дуудагчийн org-той таарахгүй |
| 409 | Блоклосон шалгалттай харилцагчид өөр identity (регистр, нэр, төрсөн огноо …, §5); эсвэл зэрэгцээ шалгалттай 3 оролдлогоор цувж чадаагүй |
| 503 | `UN_SC` / `FATF` жагсаалтыг уншиж чадахгүй, ашиглах cache байхгүй (§6) |

Оролтын хамгаалалт: body, query, path аль нь ч U+0000 эсвэл буруу бүтэцтэй Unicode (дан surrogate) агуулбал 400 (`issues[].message` = `NUL (U+0000) characters are not allowed` / `Invalid Unicode (lone surrogate) is not allowed`, `path`-д байршлыг заана; түлхүүр дэх тэмдэгтийг `\uXXXX`-ээр харуулна). Path параметр (`:id`, `:customerId`) хоосон биш string; тодорхойгүй эсвэл uuid биш id → 404. DB-ийн оролтоос үүдэлтэй алдаа (sqlstate `22021`, `22P02`, `22003`, `22001`, Prisma validation) 400 `Invalid request value`, `P2025` 404 `Record not found` болно (тогтмол мессеж, 500 биш).

**Алдааны бие.** Бүтэн аппад глобал `AllExceptionsFilter` бүх алдааг `{ code, message, details?, correlationId }` хэлбэрт оруулна (`code`: `BAD_REQUEST`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `UNAVAILABLE`, `INTERNAL` …; 5xx-ийн дотоод мессеж гарахгүй). Модулийн `ZodPipe` 400-д `{ statusCode, message: 'Validation failed', issues: [{ code, path, message }] }` үүсгэдэг боловч filter `issues`-ийг одоогоор дамжуулдаггүй: бүтэн аппад клиент зөвхөн `{ code: 'BAD_REQUEST', message: 'Validation failed', correlationId }` авна; `issues` нь модулийг filter-гүйгээр суулгасан тестэд (`aml.e2e.test.ts`) л харагдана (§10).

origination (`/api/blacklist`): `GET`, `GET :id`, `POST`, `PATCH :id`, `DELETE :id` (идэвхгүй болгоно, устгахгүй), `POST import` (CSV эсвэл JSON). **Унших — `X-User-Id`-тэй дурын дуудагч** (`X-Roles` хоосон, үл мэдэгдэх ч); хариунд тайлсан регистр орно. Gateway-н route-policy зөвхөн бичих (`writeOnly`) үйлдлийг шалгадаг тул унших дээр `blacklist:read` одоогоор хаана ч шалгагддаггүй (бүх дүрд байгаа тул практик ялгаа алга, §10). **Бичих, импорт — зөвхөн `ADMIN`** (`blacklist:manage`, gateway-н route-policy-той нийцнэ); `BRANCH_MANAGER` бичиж чадахгүй. Дэлгэрэнгүй (concurrency 409, CSV, лимит): `apps/origination/src/modules/blacklist/README.md`.

Web → зөвхөн gateway (CLAUDE.md §3.2.1): gateway ерөнхий proxy-оор `/api/kyc/…`, `/api/origination/…`-ийг дамжуулдаг (`/api/<service>/<зам>` → `<service>/api/<зам>`); AML-д зориулсан route-policy мөр нэмээгүй (дүрийн шалгалт kyc-д).

## 8. Event

| Event | Гаргагч → сонсогч | Утга |
| --- | --- | --- |
| `AmlScreeningCompleted` | kyc → origination, dwh | Шалгалт дууссан: `status`, `blocking`, `riskScore`, `riskLevel`, `hitCount` |
| `AmlHitReviewed` | kyc → origination, dwh | Hit шийдвэрлэгдсэн: шинэ `screeningStatus`, `blocking`, эрсдэл |
| `BlacklistEntryChanged` | origination → kyc | Хар жагсаалтын мөр нэмэгдэх/өөрчлөгдөх/идэвхгүй болох. `registerNoHash`-тай, plain регистргүй |

- Бүгд бизнес мөртэйгээ нэг транзакцид outbox-д бичигдэнэ; `EventsModule` relay нь `<schema>.outbox`-ийг Redis Stream `los:events` руу гаргана (`REDIS_URL` байхгүй эсвэл `OUTBOX_RELAY=off` бол bus = null: event нийтлэгдэхгүй, projection-ийн subscription үүсэхгүй). `AmlScreeningCompleted`-ийн `actorId` нь дуудсан хэрэглэгч (rescreen-д — rescreen хийсэн admin). `AmlScreeningCompleted`, `AmlHitReviewed`-ийн сонсогч (origination, dwh-sync) энэ модульд бүртгэгдээгүй — өөр thread.
- `BlacklistProjectionService` нь `onModuleInit`-д `bus.subscribe('kyc', ['BlacklistEntryChanged'])` хийнэ (consumer group = `kyc`, at-least-once). Хүргэлт амжилтгүй бол bus дахин хүргэж, 5 удаагийн дараа dead-letter stream (`los:events:dlq`) руу шилжүүлнэ. Давхардлыг `processed_events(consumer='blacklist-projection', eventId)` хаана (`DUPLICATE`), хуучин event-ийг `changedAt` хаана (`STALE`).
- `AmlHitReviewed`-ийн `screeningStatus`, `blocking`, эрсдэл нь тухайн event-ийн commit хүртэлх агрегат. Нэг screening-ийн хоёр hit-ийг зэрэг шийдвэрлэвэл түрүүлж commit-лэсэн event `REVIEW_REQUIRED` / `blocking:true` хэвээр байж болох ба сүүлд commit-лэсэн нь эцсийн төлвийг агуулна — consumer event-ийг commit-ийн дарааллаар хэрэглэнэ. HTTP хариу нь тухайн commit-д хадгалагдсан screening (event-тэй ижил агрегат); эцсийн төлвийг `GET /aml/customers/:id/latest`-ээс авна. Superseded screening-ийн hit-ийг шийдвэрлэх боломжгүй (409, §5) тул ийм event гарахгүй.
- `BlacklistEntryChanged.registerNoHash` нь `/^[0-9a-f]{64}$/` (HMAC hex; plain регистр schema-д няцна — producer, fixture бүр жинхэнэ HMAC ашиглана). `changedAt` нь мөрийн `updatedAt`-тай тэнцүү бөгөөд нэг мөрөнд хатуу өснө (`max(цаг, өмнөх updatedAt + 1мс)`); `occurredAt` нь бодит цаг тул цагийн зөрүүд `changedAt`-аас өмнө байж болно. kyc зөвхөн `changedAt` хатуу шинэ event-ийг хэрэглэнэ (тэнцүү/хуучин нь `STALE`), `eventId` давхардвал `DUPLICATE`.

## 9. Орчны хувьсагч

| Нэр | Хаана | Утга |
| --- | --- | --- |
| `INTEGRATION_MODE` | kyc | `mock` \| `real`. Тохируулаагүй/хоосон бол `mock`, ГЭХДЭЭ `NODE_ENV=production` үед тохируулаагүй бол апп эхлэхэд алдаа шидэнэ (`INTEGRATION_MODE is not set while NODE_ENV=production …`) — зохиомол жагсаалтаар чимээгүй "цэвэр" гэж хариулахаас сэргийлнэ. Тодорхой `INTEGRATION_MODE=mock` (жнь staging) зөвшөөрөгдөнө; өөр утга алдаа. `.env.example`-д `mock` |
| `NODE_ENV` | kyc | `production` үед дээрх хамгаалалт идэвхжинэ. `turbo.json` `globalPassThroughEnv`-д орсон тул `turbo run` процессод дамжина |
| `DATA_ENCRYPTION_KEY` (эсвэл `DATA_ENCRYPTION_KEYS=k1:<b64>,k2:<b64>` + `DATA_ENCRYPTION_KEY_ID`) | kyc, origination | Регистрийн AES-256-GCM түлхүүр (32 байт, base64). Түлхүүр солих: шинэ түлхүүрийг keyring-д нэмж `DATA_ENCRYPTION_KEY_ID`-г шилжүүлнэ, хуучин утга хуучин түлхүүрээр тайлагдсаар |
| `DATA_INDEX_KEY` | kyc, origination | Blind index (регистрийн hash)-ийн HMAC түлхүүр — **хоёр сервист ИЖИЛ**. Түлхүүр байхгүй бол `hashRegisterNo`/`encryptedField` алдаа (500); апп эхлэхэд шалгагддаггүй, анхны дуудлагад л илрэнэ. `NODE_ENV=test` үед түлхүүр тавиагүй бол тогтмол тестийн түлхүүр. Түлхүүр солих процесс одоогоор байхгүй (§10) |
| `REDIS_URL`, `OUTBOX_RELAY` | kyc, origination | Outbox relay ба `BlacklistProjectionService`-ийн subscription (§8). `REDIS_URL` байхгүй эсвэл `OUTBOX_RELAY=off` (тест) бол bus = null |
| `INTERNAL_AUTH_SECRET` | kyc, origination | Тохируулсан бол глобал guard `X-Internal-Token` шаардана (§7) |
| `DEFAULT_ORG_ID` | kyc, origination | `X-Org-Id` ирээгүй үед (`.env.example`-д хоосон) |
| `AML_LIST_REFRESH_MINUTES` | kyc | Жагсаалтын cache шинэчлэх давтамж, минут (анхдагч 360, `.env.example`-д 360). Эерэг тоо биш бол апп эхлэхэд алдаа |
| `DATABASE_URL` | kyc, origination | Postgres (schema `kyc`, `origination`; migrate/seed-д `scripts/prisma.mjs` `?schema=`-г нэмнэ) |
| `TEST_DATABASE_URL` | тест | DB-тэй тестийн хаалга (доор) |

`.env.example` repo-ийн root-д байна (`cp .env.example .env`): `INTEGRATION_MODE=mock`, `DEFAULT_ORG_ID=`, `AML_LIST_REFRESH_MINUTES=360`, `DATA_ENCRYPTION_KEY`, `DATA_INDEX_KEY` (ЗӨВХӨН хөгжүүлэлтийн түлхүүр — production-д өөрийнхөө түлхүүр), `REDIS_URL`, `TEST_DATABASE_URL` гэх мэт. `.env` нь root болон `apps/<svc>/`-аас ачаалагдана (`loadEnvFiles`/`ConfigModule`: `.env`, `../../.env`; орчинд тавигдсан утгыг дарахгүй; `.env` нь `.gitignore`-д). Turborepo strict env mode жагсаалтад байхгүй хувьсагчийг хасдаг тул `turbo.json`-д: `globalEnv` = `DATABASE_URL, REDIS_URL, MINIO_ENDPOINT, JWT_SECRET, INTEGRATION_MODE, DEFAULT_ORG_ID, AML_LIST_REFRESH_MINUTES`; `globalPassThroughEnv` = `TEST_DATABASE_URL, *_DATABASE_URL, NODE_ENV, OUTBOX_RELAY, STORAGE_DRIVER, MINIO_*, DATA_*, INTERNAL_AUTH_SECRET, SEED_PASSWORD`. kyc-ийн `turbo-env.test.ts` `NODE_ENV, INTEGRATION_MODE, DEFAULT_ORG_ID, AML_LIST_REFRESH_MINUTES, DATABASE_URL` эдгээрийн аль нэгэнд байгааг шалгана.

Кодод тохируулдаг (env биш): `WatchlistOptions` (`WATCHLIST_OPTIONS`): `fetchTimeoutMs` (15000), `retryBackoffMs` (30000), `minSnapshotRatio` (0.5), `refreshIntervalMinutes` (өгвөл env-ээс давамгайлна).

**Тест ба Postgres.** DB-тэй тестийн хаалга нь `TEST_DATABASE_URL` (`DATABASE_URL` биш). Өгөөгүй бол `describe.skipIf`-ээр алгасагдана: `prisma-aml.repository.int.test.ts`, `test/health.e2e.test.ts`; `aml.e2e.test.ts` нь in-memory repository-оор ажиллана (өгвөл бодит `PrismaAmlRepository`-оор). Өгвөл `test/global-setup.ts` (`@los/config/vitest/test-db.mjs`) өгөгдлийн сангийн нэр `test`-ээр **төгсөөгүй** бол татгалзаж, үгүй бол сервисийн schema-г (`kyc` / `origination`) `DROP SCHEMA … CASCADE` хийгээд `migrate deploy` + seed хийнэ; `test/setup-env.ts` тест процесст `DATABASE_URL`-ийг үүнээс `?schema=`-тай гаргаж, `NODE_ENV=test`, `OUTBOX_RELAY=off` тавьж, `INTERNAL_AUTH_SECRET`-ийг устгана. Жнь: `TEST_DATABASE_URL=postgresql://los:los@localhost:5432/los_test pnpm --filter @los/kyc test`. kyc-ийн Postgres тестүүд нэмж `kyc.aml_hit, aml_check, blacklist_projection, processed_events, outbox`-ийг **TRUNCATE** хийдэг ба `DATABASE_URL`-ийн нэрэнд `test` (том/жижиг үсэг ялгахгүй) агуулаагүй бол татгалзана (`test-db.ts`). Файлууд нэг schema-г хуваалцдаг тул vitest `nestPreset` файлуудыг дарааллаар (`fileParallelism: false`) ажиллуулна. origination-ийн int тест TRUNCATE хийхгүй (тест бүр өөрийн `orgId`-тай).

## 10. Хийгдээгүй, шийдвэр хүлээж буй зүйл

Хийгдээгүй (бусад thread-ээс хамаарна):

- `RealUnScClient`, `RealFatfClient` — `IntegrationNotImplementedError` шиднэ (UN XML татах/задлах, FATF өгөгдлийн эх сурвалж, сүлжээний зөвшөөрөл, хуулийн хяналт). Иймд `INTEGRATION_MODE=real` үед `/aml/screen` бүр fail closed 503 өгнө. Бодит клиент `fetchSnapshot(signal)`-ийн `AbortSignal`-ийг хүндэтгэх ёстой.
- Mock-ийн өгөгдөл: UN fixture нь 9 зохиомол бүртгэл (`FIXTURE-UN-*`); FATF fixture нь бодит юрисдикцүүд дээр суурилсан **жишээ** (illustrative, албан ёсны биш; `FIXTURE-` угтваргүй, `MN` ороогүй) — compliance шийдвэрийн эх сурвалж болгож болохгүй.
- `customer` хүснэгтэд иргэншил/оршин суугаа улс байхгүй (docs/03) — FATF тулгалт `AmlSubject.countries`-д найдна, хоосон бол `MN`.
- origination → kyc `POST /aml/screen` дуудагч, G1 хаалт; `AmlScreeningCompleted`/`AmlHitReviewed`-ийн сонсогч (origination, dwh-sync); хар жагсаалтын UI (`/los/loan-application/blacklist` одоо хоосон scaffold), харилцагчийн картын AML хэсэг, шийдвэрлэх дэлгэц.
- Gateway: `/api/kyc/aml/…` ерөнхий proxy-оор дамжина, AML-д зориулсан route-policy мөр, rate limit нэмээгүй.
- Rescreen-ийг cron/BullMQ-ээр автоматаар дуудах wiring (одоо ADMIN `POST /aml/rescreen` гараар).
- Maker-checker (өөр thread) бэлэн болоход hit шийдвэрлэлт, хар жагсаалтын өөрчлөлтийг 4 нүдний урсгалд холбоно; одоо `requireSeparateReviewer` хамгаалалт.
- **Хар жагсаалтын аудит (FR-13.5, who/when/before/after)**: origination-ийн blacklist модуль `audit_log` бичихгүй (суурь `recordAudit` бэлэн болсон ч холбоогүй). Үүсгэх/засах/идэвхгүй болгох бүрийн цорын ганц ул мөр нь `BlacklistEntryChanged` outbox event бөгөөд түүнд `actorId` байгаа ч `reasonText`, өмнөх төлөв (before) байхгүй.
- **Алдааны биеийн `issues`**: глобал `AllExceptionsFilter` zod-ийн `issues`-ийг дамжуулдаггүй (§7) — клиент аль талбар буруу байгааг хариунаас олохгүй. Filter-ийг (nest-common) `issues`/`details`-ээр өргөтгөх шаардлагатай.

Мэдэгдэж байгаа хязгаарлалт (шалтгаантай, зориуд хойшлуулсан):

*Нэрийн тулгалт*
- Дараалал солигдсон + бичлэгийн зөрүү + хил хязгаарын зөрүү гурав зэрэг бол олдохгүй: зөвхөн ЯГ эргэлт (`Ганболд Батэрдэнэ` ~ `Bat Erdene Ganbold`) таарна, `Ganbold Batyerdene` ~ `Bat Erdene Ganbold` (0.7833) таарахгүй. Шалтгаан: зэрэгцээ токен нэгтгэх alignment хэрэгтэй, зардал нэмэгдэж эрэмбийн хоёрдмол байдал үүснэ.
- Инициал ба бүтэн токен (`B. Ganbold` ~ `Batbayar Ganbold`) таарахгүй. Шалтгаан: `JW('e', 'erdene') = 0.75 < PAIR_MIN`; зөвшөөрвөл хуурамч тохирол огцом нэмэгдэх тул хүлээн зөвшөөрсөн зан үйл гэж үзсэн. Инициалтай нэрэнд залгасан хэлбэрт засвар зөвшөөрөхгүй (§3.3), эргэлтэд инициал оролцохгүй.
- Дүрсээр ижил хэлбэр зөвхөн латин+кирилл холимог үгэнд ажиллана; латин үгийн бүх үсгийг кирилл дүрстэйгээр бичсэн үг (бүтэн кирилл) энгийн кирилл үгээс ялгагдахгүй тул илрэхгүй.
- Регистрийн map-д кирилл `Ү → У` нэгтгэгдэнэ: 35 үсэгтэй цагаан толгойн 1225 хоёр үсгийн угтварын 69 нь өөр угтвартай нийлнэ (35² − 34²), тиймээс зөвхөн `Ү`/`У`-ээр ялгаатай регистр нэг hash, нэг маск, нэг carry-over түлхүүр авна. Хуурамч тохирол өгч болох ч хуурамч "цэвэр" өгөхгүй тул хүлээн зөвшөөрсөн (DECISIONS). `Ө` нь `О` руу нэгтгэгдэхгүй: латин `O` бичсэн `Ө` кирилл `Ө`-тэй таарахгүй.
- Бичиг баримтын төрлөөр (`Passport` / `National ID` …) шүүхгүй. Улсын шүүлтүүр зөвхөн Монгол хэлбэрийн регистрт (§3.4): тэр регистрийг улсгүй/ISO биш утгатай бичиг баримттай харьцуулах тул санамсаргүй мөргөлдөх боломжтой (hit-ийг хүн цэвэрлэнэ); бусад хэлбэрийн дугаар бүх улсын баримттай харьцуулагдана. Шалтгаан: service `countries` хоосон үед `['MN']` болгон нөхдөг (иргэншил байхгүй) тул "улс тодорхойгүй"-г ялгаж чадахгүй, төрлөөр/улсаар шүүх нь recall-ийг бууруулна. Мөн регистрийг зөвшөөрөгдөх цагаан толгойгоор няцаахгүй, нормчилно.
- Хуулийн хэлбэрийн токен жинхэнэ үгтэй давхцаж болно: `HK Electric ~ Electric` = 1 (`ХК`/`ХХК` нь `hk` болж нормчлогдоно, латин `HK` нь Hong Kong байж болно). Шалтгаан: хасалт нь recall-ийг нэмэх чиглэлтэй (max(хассан, хасаагүй)); precision-ийн өртөг нь хүний шалгалт.
- Engine-ийг event loop-оос гаргаагүй, хэрэглэгч тутмын rate limit байхгүй. Дээд хязгаарын субъект (нийт 48 үг, жишээ нь овог 6 + нэр 6 + 12 үгтэй 3 alias) ердийн субъектоос ойролцоогоор 4–10 дахин өртөгтэй: 1000 бичилттэй (тус бүр 5 нэр) жагсаалтад хэмжсэнээр (нэг машин, санамсаргүй нэрийн хоёр fixture) ердийн субъект ≈ 25–50 мс, дээд хязгаарынх ≈ 0.1–0.5 с (`ө` агуулсан хэлбэр нэмэгдэхэд ≈ 1.4 дахин) — нэг дуудлага event loop-ийг тэр хугацаанд барина; үнэмлэхүй тоо машинаас хамаарна. Шалтгаан: хамгаалалт нь токены хязгаар (§3.6), нэг удаагийн бэлтгэл, cache, `mayMatch` шүүлтүүр, JW-ийн эрт зогсолт; rate limit нь gateway-н (өөр thread) хариуцлага.
- Origination-ийн `BlacklistEntryInput` нь `isUsableRegisterNo`-г ашигладаггүй: хар жагсаалт түүхий утга ≤ 32, "нормчилсны дараа дор хаяж 1 үсэг/цифр" (`hasContent`) ба "зөвхөн үсэг/цифр/mark + тусгаарлагч" (`hasOnlyRegisterChars`)-ыг шалгадаг; "нормчилсон урт ≤ 32" дүрэм зөвхөн kyc-д (NFKC-ээр нэг тэмдэгт олон болж тэлэх регистр хар жагсаалтад орж болно). Шалтгаан: origination-ийн contracts schema-д өөрчлөлт оруулаагүй.

*Шийдвэрлэлт ба identity*
- **`CONFIRMED` hit алга болдог.** Carry-over зөвхөн шинэ шалгалтад hit гарсан үед ажиллана: бүртгэл жагсаалтаас хасагдсан (delisted) эсвэл нэр/нотолгоо өөрчлөгдөж тохирохоо больсон бол шинэ шалгалтад hit байхгүй, `CONFIRMED_MATCH` алга болж `CLEAR` болно. Carry-over зөвхөн хамгийн сүүлийн шалгалтаас авдаг тул тэр hit-гүй шалгалт сүүлийнх болсны дараа дахин тохирвол hit `OPEN` болж шинээр шийдвэрлэгдэнэ. Шалтгаан: жагсаалтаас хасагдсан этгээдийг блоклосон хэвээр байлгах нь буруу; харин "тохирохоо больсон" нь нэрийн алгоритмын хязгаараас хамаарна.
- **`FALSE_POSITIVE` нотолгоо өөрчлөгдөх бүрт дахин нээгдэнэ** (зориуд): `evidenceDigest` нь `score`, төрсөн оны тохирол, FATF ангилал, `severity`, `programme`, `listedOn`, `nationalities`, дотоод хар жагсаалтын `reasonCode`-ийг агуулдаг. Үр дагавар: нэрийн тулгалтын алгоритм өөрчлөгдөж оноо шилжсэн release бүр дараагийн шалгалтаар цэвэрлэгдсэн hit-үүдийг `OPEN` болгож (`reopenedBecause`) дахин хянуулна. Шалтгаан: нотолгоо хүчирхэгжсэнийг (жнь төрсөн он таарсан) тайван "цэвэр" гэж үлдээхээс хуурамч дахин хянуулалт нь хямд. Compliance батлах.
- **Блоклосон харилцагчийн нэр/төрсөн огноо/улс засахад 409** — hit шийдвэрлэгдтэл (бичлэгийн алдаа засах ч мөн). `CONFIRMED_MATCH` харилцагч бүртгэл жагсаалтаас хасагдаж ижил identity-ээр дахин шалгагдтал тэр identity-д түгжигдэнэ. Шалтгаан: дуудагч нэр/огноог сольж блоклосон төлвийг цэвэрлэж болохгүй; зөв шийдэл нь maker-checker (өөр thread).
- Identity хамгаалалт `customerId` тутмын: ижил хүнийг шинэ `customerId`-аар шалгавал шинэ эхлэл (guard, carry-over үйлчлэхгүй). Шалтгаан: `customerId`-ийн холбоог origination хариуцна; регистрээр org-wide нэгтгэх шийдвэр гараагүй.

*Ажиллагаа*
- **Дотоод хар жагсаалтад дараа нь нэмэгдсэн харилцагчийг rescreen олохгүй** (§6): `INTERNAL_BLACKLIST` нь `'live'` тогтмол хувилбар тул хувилбар харьцуулалтад ордоггүй; өмнө нь `CLEAR` гарсан харилцагч дараагийн шалгалт хүртэл `CLEAR` хэвээр. Шалтгаан: projection өөрчлөлтийг харилцагчтай (`registerNoHash`-аар) холбох шийдвэр гараагүй.
- `blacklist_projection` нь зөвхөн event-ээр хөтлөгдөнө (eventually consistent): relay-ийн poll (`OUTBOX_POLL_MS`, анхдагч 500 мс) + Redis + consumer-ийн хоцрогдлын хугацаанд шинэ бүртгэл screening-д харагдахгүй; bus-гүй орчинд (`REDIS_URL` байхгүй, `OUTBOX_RELAY=off`) огт шинэчлэгдэхгүй. Нөхөн sync/backfill механизм байхгүй: kyc-д хүрээгүй event Stream-д (≈ 1 000 000 хүртэл) үлдсэн л бол хэрэглэгдэнэ.
- Rescreen-ий дарааллын хамгийн хуучин `limit` ширхэг мөр байнга алдаатай бол (жнь шифр тайлагддаггүй) дараагийн ажиллагаа бүрт яг тэдгээр нь сонгогдож, бусад мөр хэзээ ч дараалалд хүрэхгүй (`limit=1` үед нэг алдаатай мөр хангалттай). Нэг ажиллагааны дотор алдаа дараагийн мөрийг зогсоохгүй (хоёр харилцагчтай тестлэсэн), алдаа одоо логлогдоно. Шалтгаан: skip/backoff-ийн багана нэмээгүй.
- Түлхүүр солих процесс байхгүй: `DATA_ENCRYPTION_KEYS` keyring нь шифрлэлтийг (хуучин утга хуучин түлхүүрээр тайлагдна) солих боломжтой ч `DATA_INDEX_KEY` нэг утгатай, `keyId`-гүй: солих бол `origination.blacklist.register_no_hash`, `kyc.aml_check.register_no_hash`, `kyc.blacklist_projection.register_no_hash` бүгд хуучирна. Rescreen тайлсан регистрийг одоогийн түлхүүрээр дахин hash хийдэг тул блоклосон харилцагчийн хадгалсан hash зөрж §5-ын 409-д орно (`failed`-д тоологдоно). Шалтгаан: hash-ийн хувилбарын урсгал хараахан байхгүй.
- Нормчлолын өөрчлөлтийн үр дагавар: `Ү`, үл үзэгдэх/compatibility тэмдэгт, ASCII биш цифр агуулсан регистрийн `registerNoHash` өөрчлөгдсөн. Өмнөх normaliser-ээр хадгалсан `origination.blacklist` мөр дахин hash хийгдэх (шифрээс тайлж шинэ `normalizeRegisterNo`, шинэ hash) шаардлагатай, `kyc.aml_check.register_no_hash`-д мөн адил (өөрчлөгдвөл §5-ын 409 ба carry-over-д нөлөөлнө). Backfill скрипт одоогоор байхгүй; өгөгдөл үйлдвэрлэлд орохоос өмнө л хамаарна.
- Жагсаалт татах алдаа үргэлжлэх үед backoff (30 с) дотор шинэ таталт эхлэхгүй ч, backoff дууссаны дараах эхний дуудлага `fetchTimeoutMs` (15 с) хүртэл хүлээж болно (origination-ийн дотоод timeout 3 с-ээс урт); cache процесс тутамд тул instance бүр өөрийн backoff-той. Шалтгаан: stale-while-revalidate (суурин дахин оролдлого) хараахан байхгүй.
- `EngineInput.lists` талбар үлдсэн (service үргэлж бүрэн `ScreeningList` дамжуулдаг). Шалтгаан: engine-ийн хэсгийг хөндөөгүй; дараа нь устгана.
- Модулийн TRUNCATE хамгаалалт `DATABASE_URL`-ийн нэрэнд `test` гэсэн тэмдэгт мөрийг (том/жижиг үсэг ялгахгүй) хайдаг тул өөр үгийн дотор `test` агуулсан нэр (жнь `latest`) нэвтэрнэ. Тест ажиллуулахад `TEST_DATABASE_URL`-ийн `…test`-ээр төгсөх шаардлага (`global-setup`) түүнийг хатуу болгодог тул бодит эрсдэл бага. Шалтгаан: энгийн дүрэм.
- Зэрэгцээ олон instance байвал `AML_LIST_REFRESH_MINUTES`-ийн lazy refresh instance тутамд тусдаа тул instance хооронд `listVersions` түр зөрж болно (rescreen нэгийг нь "хуучирсан" гэж үзнэ).

*Хар жагсаалтын импорт (origination)*
- 5000 мөртэй импорт нь НЭГ синхрон HTTP хүсэлт (мөр бүр тусдаа транзакц) тул олон секунд үргэлжилж, CLAUDE.md §3.1-ийн дотоод timeout (3 с)-оос хэтэрч болзошгүй. Шалтгаан: BullMQ job болгох нь тусдаа ажил.
- Хуучин CSV-г дахин импортлоход идэвхгүй болгосон мөрүүд **дахин идэвхжинэ** (импортолсон хэрэглэгч, цаг, салбараар шинээр бүртгэгдэнэ). Шалтгаан: импорт нь `(org, регистр hash, listType)`-ээр upsert хийдэг, идэвхгүйг чимээгүй алгасвал мастер CSV-ийн утга алдагдана; админ санаатай идэвхгүй болгосныг буцаах эрсдэлтэй.
- `Expect: 100-continue` илгээдэг клиент (жнь `curl` том файлд): Node нь middleware ажиллахаас өмнө `100 Continue` хариулдаг тул 401/403/413 шийдэгдэхээс өмнө клиент upload эхлүүлнэ. Сервер cap дээр уншихаа зогсоож холболтыг хаадаг ч эхний урсгалыг зогсоож чадахгүй. Шалтгаан: HTTP серверийн `checkContinue` handler шаардлагатай — модулийн гадна.
- CSV middleware нь глобал guard-аас өмнө ажилладаг тул body-г (≤ 5 MB) `X-Internal-Token` шалгагдахаас өмнө уншина (`INTERNAL_AUTH_SECRET` тохируулсан ч); тус middleware-ийн өөрийн шалгалт зөвхөн `X-User-Id`/`X-Org-Id`/дүр. Gateway-г тойрсон дотоод дуудагч л үүнийг ашиглана.
- Дотоод алдаа: нэг бичлэгийн endpoint (POST/PATCH/DELETE/GET) дээр шифр/hash алдаа (түлхүүр байхгүй), гэнэтийн DB алдаа 500 (`INTERNAL`) өгнө; харин CSV/JSON импортод мөр бүрийн ийм алдаа `errors[]`-д `Row could not be saved (internal error)` болж, HTTP **200** (бүх мөр унавал `created=updated=skipped=0`, бүх мөр `errors[]`-д). Статус код л шалгадаг скрипт буруу тохиргоог амжилттай импорт гэж ойлгож болно. Origination-д DB-ийн оролтын алдааг (sqlstate `22021` гэх мэт) 400 болгох interceptor байхгүй (kyc-д `DbInputErrorInterceptor` бий); оролтын хил дээр (NUL, U+FFFD, дан surrogate, `offset`) 500-ын эх үүсвэрийг хаасан, nest-common filter `P2002` → 409, `P2025` → 404 болгоно. Шалтгаан: зориуд бага өөрчлөлт.
- JSON импортод NUL, U+FFFD, дан surrogate байвал бүх body 400 (мөрийн алдаа биш). Шалтгаан: хэсэгчлэн импортлохоос сэргийлнэ.
- origination-ийн жинхэнэ event-үүдийг kyc-ийн `BlacklistProjectionService`-д өгдөг cross-service тест байхгүй. Шалтгаан: CLAUDE.md сервис хоорондын import-ыг хориглодог; origination талд event бүр `DomainEvent.parse`-аар шалгагддаг.
- Хувилбарын багана (`version`) болон event-ийн `version` талбар нэмээгүй: `updatedAt` compare-and-set + хатуу өсөх `changedAt` нь schema/гэрээ өөрчлөхгүйгээр дарааллыг шийддэг.

## 11. Хяналтын шалгалт

Хоёр удаагийн adversarial хяналт хийгдэж, олдсон зүйлс засагдан энэ баримтын холбогдох хэсэгт тусгагдсан (тулгалт §3, шийдвэрлэх урсгал ба нэг харилцагчийн цуваа §5, жагсаалтын найдвартай байдал §6, Модуль 0-ийн суурьтай нэгтгэсэн орчин §9). Засаагүй, зориуд хойшлуулсан зүйлс §10-д шалтгаантайгаа бий.
