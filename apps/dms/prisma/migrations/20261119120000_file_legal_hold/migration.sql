-- M10 (dms): retention sweeper-ийн хууль ёсны саатуулга (legal hold) — true бол хугацаа дууссан ч устгахгүй.
ALTER TABLE "dms"."file" ADD COLUMN "legal_hold" BOOLEAN NOT NULL DEFAULT false;
