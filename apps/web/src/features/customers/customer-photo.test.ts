import { describe, expect, it } from 'vitest';
import { PHOTO_ACCEPT, PHOTO_MAX_BYTES, validatePhotoFile } from './customer-photo';

// F1-12: ИҮ-ийн зургийн файлыг илгээхээс ӨМНӨ шалгана; татгалзвал шалтгаан (type / size / empty) буцаана.
const file = (name: string, size: number) => ({ name, size });

describe('validatePhotoFile', () => {
  it('accepts png / jpg / jpeg / pdf in any letter case', () => {
    for (const name of ['id.png', 'id.JPG', 'id.Jpeg', 'scan.pdf', 'a.b.c.png']) expect(validatePhotoFile(file(name, 1024))).toBeNull();
  });

  it('EMPTY for a 0-byte file, whatever its name', () => {
    expect(validatePhotoFile(file('id.png', 0))).toBe('EMPTY');
    expect(validatePhotoFile(file('run.exe', 0))).toBe('EMPTY');
  });

  it('TYPE for other extensions, no extension and a double extension that ends in a forbidden one', () => {
    for (const name of ['setup.exe', 'doc.docx', 'notes.txt', 'noext', 'photo.png.exe', '.png.', 'png']) expect(validatePhotoFile(file(name, 1024)), name).toBe('TYPE');
  });

  it('TOO_LARGE only above the limit; exactly the limit is accepted', () => {
    expect(validatePhotoFile(file('id.png', PHOTO_MAX_BYTES))).toBeNull();
    expect(validatePhotoFile(file('id.png', PHOTO_MAX_BYTES + 1))).toBe('TOO_LARGE');
  });

  it('PHOTO_ACCEPT lists exactly the accepted extensions for the file picker', () => {
    expect(PHOTO_ACCEPT).toBe('.png,.jpg,.jpeg,.pdf');
  });
});
