import { BadRequestException } from '@nestjs/common';
import { sharp } from './sharp';
import { detectImageType, ImageFilePipe } from './image-file.pipe';

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1,
]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]);
const WEBP_SIGNATURE = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('WEBPVP8 '),
]);

/** Imagen real de color sólido. */
function image(
  format: 'png' | 'jpeg' | 'webp',
  width = 40,
  height = 30,
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 50, b: 50 },
    },
  })
    .toFormat(format)
    .toBuffer();
}

function upload(buffer: Buffer, mimetype: string): Express.Multer.File {
  return { buffer, mimetype, size: buffer.length } as Express.Multer.File;
}

describe('detectImageType', () => {
  it.each([
    [PNG_SIGNATURE, 'image/png', 'png'],
    [JPEG_SIGNATURE, 'image/jpeg', 'jpg'],
    [WEBP_SIGNATURE, 'image/webp', 'webp'],
  ])('reconoce la firma real', (buffer, mimeType, extension) => {
    expect(detectImageType(buffer)).toEqual({ mimeType, extension });
  });

  it.each([
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    Buffer.from('GIF89a'),
    Buffer.from([0x89, 0x50]),
    Buffer.alloc(0),
  ])('rechaza lo que no es JPEG, PNG ni WEBP', (buffer) => {
    expect(detectImageType(buffer)).toBeNull();
  });
});

describe('ImageFilePipe', () => {
  const pipe = new ImageFilePipe();

  it.each([
    ['png', 'image/png', 'png'],
    ['jpeg', 'image/jpeg', 'jpg'],
    ['webp', 'image/webp', 'webp'],
  ] as const)(
    'vuelve a generar %s en el mismo formato',
    async (format, mimeType, extension) => {
      const result = await pipe.transform(
        upload(await image(format), mimeType),
      );
      expect(result).toMatchObject({ mimeType, extension });
      const meta = await sharp(result.buffer).metadata();
      expect(meta.format).toBe(format);
      expect([meta.width, meta.height]).toEqual([40, 30]);
    },
  );

  it('descarta los metadatos EXIF (GPS, dispositivo)', async () => {
    const withExif = await sharp(await image('jpeg'))
      .withExif({
        IFD0: { Make: 'Celular', Model: 'X1' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '4/1 36/1 0/1' },
      })
      .jpeg()
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();

    const result = await pipe.transform(upload(withExif, 'image/jpeg'));
    expect((await sharp(result.buffer).metadata()).exif).toBeUndefined();
  });

  it('reduce a 512 px como máximo sin deformar', async () => {
    const result = await pipe.transform(
      upload(await image('png', 1000, 800), 'image/png'),
    );
    const meta = await sharp(result.buffer).metadata();
    expect([meta.width, meta.height]).toEqual([512, 410]);
  });

  it('400 con una imagen "bomba" (demasiados píxeles)', async () => {
    const huge = await image('png', 5000, 5000);
    await expect(
      pipe.transform(upload(huge, 'image/png')),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('400 si solo imita la cabecera (contenido arbitrario detrás)', async () => {
    const fake = Buffer.concat([JPEG_SIGNATURE, Buffer.from('PK zip...')]);
    await expect(
      pipe.transform(upload(fake, 'image/jpeg')),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('400 si no se adjunta archivo', async () => {
    await expect(pipe.transform(undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      pipe.transform(upload(Buffer.alloc(0), 'image/png')),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('400 si el MIME declarado no está permitido (SVG)', async () => {
    await expect(
      pipe.transform(upload(Buffer.from('<svg/>'), 'image/svg+xml')),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('400 si los bytes no coinciden con el tipo declarado', async () => {
    await expect(
      pipe.transform(upload(Buffer.from('no soy png'), 'image/png')),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      pipe.transform(upload(await image('jpeg'), 'image/png')),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('400 si supera 2 MB', async () => {
    const big = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(2 * 1024 * 1024)]);
    await expect(
      pipe.transform(upload(big, 'image/png')),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
