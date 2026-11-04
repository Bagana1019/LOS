-- Q-135: дотоод хар жагсаалтын түвшин (BLACK/GREY) AML эрсдэлийн жинд. Одоо байгаа мөр BLACK.
ALTER TABLE "kyc"."blacklist_projection" ADD COLUMN "severity" TEXT NOT NULL DEFAULT 'BLACK';
