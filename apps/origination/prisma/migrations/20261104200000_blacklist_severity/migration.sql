-- Хар жагсаалтын түвшин: BLACK (хар) / GREY (саарал). Одоо байгаа бүх мөр BLACK. BR-9 хэвээр (зөвхөн анхааруулга).
ALTER TABLE "origination"."blacklist" ADD COLUMN "severity" TEXT NOT NULL DEFAULT 'BLACK';
ALTER TABLE "origination"."blacklist" ADD CONSTRAINT "blacklist_severity_check" CHECK ("severity" IN ('BLACK', 'GREY'));
