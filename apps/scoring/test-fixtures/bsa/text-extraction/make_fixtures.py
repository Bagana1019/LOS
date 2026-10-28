#!/usr/bin/env python3
"""
SYNTHETIC fixture generator for the text-extraction tests. Every name, account, register number and amount below is made up.
No real bank statement, person or account is represented, and the layouts are NOT copies of any bank's format (TODO(samples)).

Usage (from this folder):  python3 -I make_fixtures.py
Needs: Pillow, reportlab, pypdf, DejaVu Sans (/usr/share/fonts/truetype/dejavu).
Outputs: statement-table.png, cyrillic-statement.pdf, encrypted-user-password.pdf, encrypted-owner-only.pdf
"""
from pathlib import Path

HERE = Path(__file__).resolve().parent
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
FONT_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'

HEADERS = ['Огноо', 'Гүйлгээний утга', 'Зарлага', 'Орлого', 'Үлдэгдэл']
ROWS = [
    ['2026-03-01', 'Цалин 2026 оны 02 сар', '', '1,500,000.00', '2,300,000.00'],
    ['2026-03-02', 'Дэлгүүрийн худалдан авалт', '45,900.00', '', '2,254,100.00'],
    ['2026-03-05', 'Зээлийн төлбөр', '350,000.00', '', '1,904,100.00'],
    ['2026-03-09', 'Шилжүүлэг ЗОХИОМОЛ ХХК', '', '820,500.00', '2,724,600.00'],
    ['2026-03-12', 'Үйлчилгээний шимтгэл', '1,000.00', '', '2,723,600.00'],
]


def make_png() -> None:
    from PIL import Image, ImageDraw, ImageFont

    font = ImageFont.truetype(FONT, 30)
    bold = ImageFont.truetype(FONT_BOLD, 30)
    # Баганы зүүн ирмэг (px) — багана хоорондын зай том (≥ 60px) тул нүд тусдаа гарна
    xs = [40, 270, 800, 1010, 1230]
    img = Image.new('RGB', (1560, 120 + 60 * (len(ROWS) + 1)), 'white')
    d = ImageDraw.Draw(img)
    d.text((40, 20), 'ДАНСНЫ ХУУЛГА (ЗОХИОМОЛ ЖИШЭЭ)', font=bold, fill='black')
    y = 90
    for x, h in zip(xs, HEADERS):
        d.text((x, y), h, font=bold, fill='black')
    for row in ROWS:
        y += 60
        for x, cell in zip(xs, row):
            d.text((x, y), cell, font=font, fill='black')
    img.save(HERE / 'statement-table.png', dpi=(300, 300), optimize=False)


def make_cyrillic_pdf() -> None:
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas

    pdfmetrics.registerFont(TTFont('DejaVu', FONT))
    c = canvas.Canvas(str(HERE / 'cyrillic-statement.pdf'), pagesize=(595, 842), invariant=1)
    c.setTitle('ЗОХИОМОЛ хуулга')
    c.setAuthor('Synthetic Generator')
    c.setCreator('make_fixtures.py')
    c.setFont('DejaVu', 9)
    xs = [40, 110, 300, 380, 470]
    y = 800
    for x, h in zip(xs, HEADERS):
        c.drawString(x, y, h)
    for row in ROWS:
        y -= 14
        for x, cell in zip(xs, row):
            if cell:
                c.drawString(x, y, cell)
    c.drawString(40, y - 14, 'Өндөр Үнэтэй Өрөө Үйлчилгээ')  # Ө, Ү тэмдэгтүүд
    c.showPage()
    c.save()


def make_latin_pdf(path: Path) -> None:
    from reportlab.pdfgen import canvas

    c = canvas.Canvas(str(path), pagesize=(595, 842), invariant=1)
    c.setFont('Helvetica', 10)
    c.drawString(40, 800, 'Date')
    c.drawString(200, 800, 'Amount')
    c.drawString(40, 785, '2026-03-01')
    c.drawString(200, 785, '1,234.50')
    c.showPage()
    c.save()


def make_encrypted() -> None:
    from pypdf import PdfReader, PdfWriter

    src = HERE / '_plain.pdf'
    make_latin_pdf(src)
    for name, user, owner in [('encrypted-user-password.pdf', 'userpw', 'ownerpw'), ('encrypted-owner-only.pdf', '', 'ownerpw')]:
        w = PdfWriter()
        for p in PdfReader(str(src)).pages:
            w.add_page(p)
        w.encrypt(user_password=user, owner_password=owner, algorithm='RC4-128')
        with open(HERE / name, 'wb') as f:
            w.write(f)
    src.unlink()


if __name__ == '__main__':
    make_png()
    make_cyrillic_pdf()
    make_encrypted()
    print('ok')
