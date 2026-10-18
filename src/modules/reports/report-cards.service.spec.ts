import { DataSource } from 'typeorm';
import { StorageService } from '../../storage/storage.service';
import { ReportCardsService } from './report-cards.service';

describe('ReportCardsService: PDF recién subido tras un error (B3)', () => {
  const existsBy = jest.fn();
  const storage = { removeQuietly: jest.fn() };
  const service = new ReportCardsService(
    { getRepository: () => ({ existsBy }) } as unknown as DataSource,
    null as never,
    null as never,
    null as never,
    null as never,
    storage as unknown as StorageService,
  );
  const discard = (path: string) =>
    (
      service as unknown as { discardUpload: (p: string) => Promise<void> }
    ).discardUpload(path);

  beforeEach(() => jest.clearAllMocks());

  it('lo borra si ningún boletín lo usa', async () => {
    existsBy.mockResolvedValue(false);
    await discard('i/report-cards/a.pdf');
    expect(existsBy).toHaveBeenCalledWith({ pdfPath: 'i/report-cards/a.pdf' });
    expect(storage.removeQuietly).toHaveBeenCalledWith(
      'report-cards',
      'i/report-cards/a.pdf',
    );
  });

  it('no lo borra si el COMMIT sí quedó (la fila lo usa) ni si no hay base', async () => {
    existsBy.mockResolvedValueOnce(true);
    await discard('i/report-cards/b.pdf');
    existsBy.mockRejectedValueOnce(new Error('sin conexión'));
    await discard('i/report-cards/c.pdf');
    expect(storage.removeQuietly).not.toHaveBeenCalled();
  });
});
