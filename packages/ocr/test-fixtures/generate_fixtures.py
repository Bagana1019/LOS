#!/usr/bin/env python3
"""SYNTHETIC OCR fixtures generator (packages/ocr/test-fixtures).

Бүх өгөгдөл зохиомол (SYNTHETIC): бодит хүн, байгууллага, регистр, данс байхгүй.
Ажиллуулах:  python3 packages/ocr/test-fixtures/generate_fixtures.py [out_dir]
Шаардлага:  Python 3 + Pillow + DejaVu Sans фонт (/usr/share/fonts/truetype/dejavu).
Үр дүн: id-card.png, id-card-stacked.png, salary-certificate.png (цэвэр), id-card-photo.jpg, salary-certificate-photo.jpg
(гар утасны зураг дуурайсан: эргэлт, бүдэгрэл, жижигрэлт, JPEG, толбо), two-page.pdf (зураг-PDF: 1-р хуудас ID карт, 2-р тодорхойлолт),
blank.png (текстгүй цагаан зураг → EMPTY_RESULT).
Seed тогтмол тул deterministic (цаг ашиглаагүй).
"""
import random
import sys
import time
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONT_REGULAR = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
FONT_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
DPI = (300, 300)


def font(path, size):
    return ImageFont.truetype(path, size)


def new_page(width, height):
    img = Image.new('L', (width, height), 255)
    return img, ImageDraw.Draw(img)


def id_card_same_line(path):
    """Иргэний үнэмлэхтэй төстэй: "Шошго / Label:  Утга" нэг мөрөнд."""
    img, d = new_page(1800, 1180)
    d.rectangle((20, 20, 1779, 1159), outline=0, width=4)
    d.text((90, 60), 'МОНГОЛ УЛС / MONGOLIA', font=font(FONT_BOLD, 48), fill=0)
    d.text((90, 140), 'ИРГЭНИЙ ҮНЭМЛЭХ / IDENTITY CARD', font=font(FONT_BOLD, 48), fill=0)
    rows = [
        ('Овог / Surname:', 'Дорж'),
        ('Нэр / Given name:', 'Болд'),
        ('Хүйс / Sex:', 'Эр'),
        ('Төрсөн огноо:', '1985.06.15'),
        ('Регистрийн дугаар:', 'ЖЮ85061512'),
        ('Үнэмлэхний дугаар:', 'MN1234567'),
        ('Хүчинтэй хугацаа:', '2030.04.12'),
    ]
    y = 290
    for label, value in rows:
        d.text((90, y), label, font=font(FONT_REGULAR, 44), fill=0)
        d.text((820, y), value, font=font(FONT_BOLD, 52), fill=0)
        y += 120
    img.save(path, dpi=DPI)


def id_card_stacked(path):
    """Шошго дээр, утга доор нь (утга дараагийн мөрөнд)."""
    img, d = new_page(1500, 1500)
    d.text((80, 50), 'ИРГЭНИЙ ҮНЭМЛЭХ', font=font(FONT_BOLD, 52), fill=0)
    rows = [
        ('Овог', 'Сүхбаатар'),
        ('Нэр', 'Оюунчимэг'),
        ('Хүйс', 'Эм'),
        ('Төрсөн огноо', '1992.11.03'),
        ('Регистрийн дугаар', 'УБ92110384'),
    ]
    y = 190
    for label, value in rows:
        d.text((80, y), label, font=font(FONT_REGULAR, 38), fill=0)
        d.text((80, y + 60), value, font=font(FONT_BOLD, 56), fill=0)
        y += 230
    img.save(path, dpi=DPI)


def salary_certificate(path):
    """Цалингийн тодорхойлолт (A4, 300 dpi, догол мөр бүхий өгүүлбэр)."""
    img, d = new_page(2480, 3508)
    f = font(FONT_REGULAR, 48)
    fb = font(FONT_BOLD, 60)
    d.text((200, 220), '"Тэнгэр Трейд" ХХК', font=fb, fill=0)
    d.text((200, 320), 'Улаанбаатар хот, Сүхбаатар дүүрэг', font=f, fill=0)
    d.text((200, 390), 'Утас: 99112233', font=f, fill=0)
    d.text((820, 600), 'ЦАЛИНГИЙН ТОДОРХОЙЛОЛТ', font=fb, fill=0)
    d.text((200, 720), '2026 оны 09 сарын 15', font=f, fill=0)
    d.text((1900, 720), 'Дугаар 12/45', font=f, fill=0)
    body = [
        'Иргэн Дорж овогтой Болд (РД: ЖЮ85061512) нь манай байгууллагад',
        '2020 оноос хойш Санхүүгийн албаны мэргэжилтнээр ажиллаж байгаа',
        'бөгөөд сүүлийн 6 сарын дундаж цалин 1,800,000 төгрөг байна.',
        'Энэхүү тодорхойлолтыг Хаан банкинд өгөв.',
    ]
    y = 900
    for line in body:
        d.text((200, y), line, font=f, fill=0)
        y += 90
    d.text((200, 1500), 'Захирал:  ______________  Б.Гэрэл', font=f, fill=0)
    img.save(path, dpi=DPI)


def photo_like(src, dst, seed=7, rotate=1.0, blur=0.8, scale=0.7, quality=70):
    """Цэвэр зургийг "утасны зураг" шиг муутгана: эргүүлэх, жижигрүүлэх, бүдгэрүүлэх, толбо (seed тогтмол), JPEG."""
    rng = random.Random(seed)
    im = Image.open(src).convert('L')
    x = im.rotate(rotate, expand=True, fillcolor=255, resample=Image.BICUBIC)
    x = x.resize((int(x.width * scale), int(x.height * scale)), Image.BILINEAR).filter(ImageFilter.GaussianBlur(blur))
    px = x.load()
    for _ in range(int(x.width * x.height * 0.004)):
        px[rng.randrange(x.width), rng.randrange(x.height)] = rng.choice([0, 255])
    x.save(dst, quality=quality, dpi=(int(300 * scale), int(300 * scale)))


def two_page_pdf(first, second, dst):
    """Зөвхөн зурагтай (text layer-гүй) 2 хуудастай PDF — pdftoppm → OCR замыг шалгана."""
    # 1-bit (CCITT G4) тул жижиг; creationDate тогтмол тул deterministic
    a = Image.open(first).convert('L').point(lambda v: 255 if v > 140 else 0).convert('1')
    b = Image.open(second).convert('L').point(lambda v: 255 if v > 140 else 0).convert('1')
    fixed = time.struct_time((2026, 10, 28, 0, 0, 0, 2, 301, 0))
    a.save(dst, 'PDF', resolution=300.0, save_all=True, append_images=[b], creationDate=fixed, modDate=fixed, producer='LOS Radix synthetic fixtures')


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent
    out.mkdir(parents=True, exist_ok=True)
    id_card_same_line(out / 'id-card.png')
    id_card_stacked(out / 'id-card-stacked.png')
    salary_certificate(out / 'salary-certificate.png')
    photo_like(out / 'id-card.png', out / 'id-card-photo.jpg')
    photo_like(out / 'salary-certificate.png', out / 'salary-certificate-photo.jpg')
    new_page(600, 300)[0].save(out / 'blank.png', dpi=DPI)
    two_page_pdf(out / 'id-card.png', out / 'salary-certificate.png', out / 'two-page.pdf')


if __name__ == '__main__':
    main()
