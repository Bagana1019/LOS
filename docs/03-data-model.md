# LOS Radix — Өгөгдлийн загвар

Бүх хүснэгт: `id` (bigserial/uuid), `created_at`, `updated_at`, `created_by`, `updated_by`, `org_id` (multi-tenant), `branch_id` (хаана хамаатай). Мөнгө `numeric(18,2)`, хувь `numeric(7,4)` (0.55 = 55%). Soft delete хэрэггүй — төлвөөр удирдана. Шифрлэх талбар: `*_encrypted` (pgcrypto).

## Enum
```
BorrowerRole      PRIMARY | CO_BORROWER | GUARANTOR | PLEDGOR
CustomerType      INDIVIDUAL | LEGAL_ENTITY
ApplicationStatus DRAFT | SUBMITTED | IN_APPROVAL | APPROVED | RETURNED | DISBURSING | ACTIVE | CLOSED | MIGRATED
StepKey           client | inquiry | income | loan | collateral | installment | score | document | decision | contract | official_documents | disburse
StepStatus        LOCKED | PENDING | COMPLETED | STALE
ApprovalDecision  APPROVE | RETURN
CalcMethod        A_SALARY | B_BUSINESS | C_COMBINED
RepaymentType     ANNUITY | EQUAL_PRINCIPAL | QUARTERLY | BULLET
CollateralKind    MOVABLE | IMMOVABLE
AssetType         VEHICLE | APARTMENT | HOUSE | LAND | LIVESTOCK | INVENTORY | EQUIPMENT | OTHER
ValuationSource   INTERNAL | EXTERNAL_LICENSED
InquirySource     CIB | FICO | DTI | LIVESTOCK | XYP_PROPERTY | XYP_VEHICLE | XYP_PENSION | XYP_LEGAL | XYP_CRIMINAL | XYP_COURT_DEBT | BLACKLIST
BlacklistReason   free text + code
BsaStatus         DRAFT | ANALYZED
ImportStatus      PENDING | PROCESSING | COMPLETED | FAILED
TxnDirection      INCOME | EXPENSE
SuspicionFlag     OWN_ACCOUNT | CIRCULAR | INTER_ACCOUNT_FRAUD | QUICK_CASH | SPLIT_WITHDRAWAL | COLLUSION | STRUCTURING | GAMBLING
ReviewStatus      PENDING | RESOLVED
ReviewAction      APPROVE | RECLASSIFY | EXCLUDE
NotificationType  APPROVAL_REQUESTED | RETURNED | APPROVED | DISBURSEMENT_APPROVED | SLA_BREACH | MENTION
```

## Харилцагч, хүсэлт

**customer** — register_no (unique, encrypted index hash), customer_type, last_name, first_name, gender, birth_date, phone, email, photo_file_id, family_size, activity_sector, marital_status, segment, education, is_related_party (KYC), is_pep, aml_risk_score, official_address_json, residence_address_json, employment_json (org, position, address, phone, social), xyp_fetched_at
**customer_contact** — customer_id, relation, register_no, last_name, first_name, phone, employment, home_address
**customer_bank_account** — customer_id, bank_code, account_no (encrypted), iban, holder_name, source (MANUAL | STATEMENT)

**loan_application** — app_no, org_id, branch_id, officer_id (ЗЭЗ; null → "Систем"), status, product_id, purpose, purpose_detail, cib_purpose_code, cib_sub_code, currency, amount, interest_rate, term_months, fee_rate, down_payment, charges, insurance, officer_note, contract_no (nullable, батлагдсаны дараа), decided_at, submitted_at, approved_at, returned_at, disbursed_at, selected_calc_method, calc_snapshot_json, bsa_summary_json, source (WEB | SYSTEM | API), version, parent_application_id (дахин илгээлтийн хувилбар)
**loan_application_borrower** — application_id, customer_id, role (BorrowerRole), is_primary
**loan_application_step** — application_id, step_key, status (StepStatus), completed_at, stale_reason

## Лавлагаа
**inquiry** — application_id, customer_id, source (InquirySource), fetched_at, fetched_by, expires_at, raw_json, summary_json (active_loan_count, total_disbursed, outstanding, monthly_payment, fico_score, dti…), warning_level
**unregistered_loan** — application_id, customer_id, lender_name, amount, monthly_payment, note (ЗМС-д бүртгэлгүй зээл, гараар)

## Орлого
**income_salary** — application_id, customer_id, employer, year, month, salary, contribution_paid, source (NDSH | MANUAL)
**income_manual** — application_id, customer_id, type (RENT | PENSION | OTHER), monthly_amount, file_id, note
**income_summary** — application_id, customer_id, period_from, period_to, avg_salary_monthly, business_ncf_monthly (BSA-аас), household_expense_monthly, business_expense_monthly

## Бүтээгдэхүүн, тохиргоо (модуль 12)
**product** — code, name, product_type, currency, min_amount, max_amount, min_term, max_term, min_rate, max_rate, default_fee_rate, requires_collateral, max_ltv, max_dti (ӨОХ), min_dscr (ӨТЧХ), calc_weight_threshold (0.70), contract_template_id, document_checklist_json, collateral_checklist_json (by AssetType), haircut_json (by AssetType), external_valuation_threshold, cost_of_goods_rate (ББӨ), is_active
**approval_level** — org_id, product_id (nullable = бүх бүтээгдэхүүн), level_no, name, amount_from, amount_to, quorum_type (MAJORITY), sla_hours
**approval_level_member** — approval_level_id, user_id (эсвэл role + branch scope)
**contract_number_template** — org_id, pattern (жишээ `{PREFIX}{BRANCH}{YYMMDD}{SEQ:2}`), prefix, seq_scope (DAY | BRANCH | GLOBAL), next_seq
**contract_template** — product_id, type (LOAN_CONTRACT | SCHEDULE | OFFICIAL_LETTER), name, docx_file_id, placeholders_json, version
**setting** — org_id, key, value_json (BR босго, лавлагааны хуучралт N хоног, ноорог архивлах хоног, BSA ангилал/дайчлах хувь, дохионы босго, хадгалах 3 жил…)
**base_price** — asset_type, key_json (make/model/year | district/khoroo | livestock_type/age), unit_price, valid_from, version

## Барьцаа, үнэлгээ (модуль 5)
**collateral** — application_id, kind, asset_type, owner_customer_id (барьцаалагч), description_json (plate, make, model, year, mileage | address, area_m2, floor, certificate_no | head_count…), source (XYP | MANUAL), market_value, haircut_rate, collateral_value (= market × haircut), ownership_verified, ownership_check_json, encumbrance_check_json (ЗМС/ЭБ), encumbrance_status (CLEAR | ENCUMBERED | DISPUTED), registry_no (ЭБ), registry_date, released_at, insurance_expires_at, next_revaluation_at
**collateral_valuation** — collateral_id, source (ValuationSource), appraiser, valued_at, valid_until, market_value, method_json, report_file_id, override_reason
**collateral_document** — collateral_id, checklist_key, file_id, uploaded_by, uploaded_at

## ЭТХ, тооцоолол
**repayment_schedule** — application_id, params_json (start, end, type, first_payment_date, grace_months), generated_at, is_stale
**repayment_schedule_row** — schedule_id, seq, due_date, days, disbursement, principal, interest, total, balance
**calculation** — application_id, computed_at, inputs_json, method_a_json, method_b_json, method_c_json, auto_selected_method, selected_method, selected_by, policy_check_json (dti, dscr, ltv: value, limit, pass), stress_json, is_stale

## Баримт, шийдвэр, батлах
**document** — application_id, type, related_entity (BORROWER | COLLATERAL | APPLICATION), related_id, note, file_id, checklist_key
**approval_request** — application_id, version, level_no, started_at, due_at, status (PENDING | APPROVED | RETURNED)
**approval_vote** — approval_request_id, approver_id, decision, comment, decided_at
**decision_record** — application_id, decision_no, decided_at, minutes_text, file_id

## Гэрээ, олголт
**contract** — application_id, contract_no, template_version, generated_file_id, signed_file_id, signed_at
**official_letter** — application_id, template_id, generated_file_id, printed_at
**disbursement_request** — application_id, approved_amount, disburse_amount, term_months, interest_rate, repayment_type, first_payment_date, disburse_date, bank_code, account_no (encrypted), holder_name, account_owner_type (SELF | THIRD_PARTY), name_check_json, reconciliation_json, status (DRAFT | SUBMITTED | APPROVED | SENT_TO_CORE | FAILED), core_loan_id, history_json

## BSA (модуль 10)
**bsa_analysis** — application_id, customer_id, status (BsaStatus), version, period_from, period_to, period_months, proposed_monthly_payment, cost_of_goods_rate, summary_json (INT-4 гэрээтэй ижил), analyzed_at, pushed_to_los_at
**bsa_import_job** — analysis_id, file_id, bank_code, format, account_no, iban, holder_name, period_from, period_to, status (ImportStatus), rows_total, rows_done, errors_json, parser_ok, verifier_ok, qr_verified
**bsa_transaction** — analysis_id, import_job_id, txn_date, txn_time, direction, amount, balance_after, description, counterparty_account, counterparty_name, channel (QPAY | POS | ATM | TRANSFER | OTHER), category_code, category_group, confidence, is_own_transfer, manual_override, override_by
**bsa_category** — org_id, code, direction, group_code, name, weight (дайчлах хувь), dti_role (INCOME | DEBT_SERVICE | HOUSEHOLD | BUSINESS_EXPENSE | EXCLUDE | INFO), is_active
**bsa_rule** — org_id, direction, match_type (KEYWORD | COUNTERPARTY | REGEX), pattern, category_code, priority, source (ADMIN | FEEDBACK)
**bsa_suspicion** — analysis_id, flag (SuspicionFlag), transaction_ids (array), confidence, status (ReviewStatus), action (ReviewAction), comment, resolved_by, resolved_at

## Хар жагсаалт, мэдэгдэл, аудит (модуль 11)
**blacklist** — org_id, register_no, customer_type, name, list_type, reason_code, reason_text, registered_by, registered_at, is_active
**notification** — user_id, type, application_id, payload_json, read_at
**comment** — application_id, author_id, body, mentions (user_id[]), created_at
**audit_log** — entity, entity_id, action, actor_id, at, before_json, after_json, application_id (index)
**file** — storage_key (MinIO), name, mime, size, sha256, uploaded_by

## Хэрэглэгч, эрх
**user** — org_id, branch_id, username, password_hash, full_name, roles (OFFICER | BRANCH_MANAGER | APPROVER | ADMIN), is_active
**branch** — org_id, code, name
**org** — code, name

## Харилцааны гол дүрэм
- loan_application 1—N borrower; 1—N step (12 мөр урьдчилан үүснэ); 1—N inquiry; 1—N collateral; 1—1 current repayment_schedule; 1—1 current calculation; 1—N approval_request (version тутамд level бүр); 1—1 contract; 1—1 disbursement_request; 1—N bsa_analysis (зээлдэгч тутамд 1 идэвхтэй).
- Нэг collateral (registry_no эсвэл description key) идэвхтэй олон application-д давхар байхгүй (unique partial index, FR-6.6).
- Төлөв өөрчлөлт бүр audit_log + loan_application_step-ийн дахин тооцоо (domain event).
