import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { paginate, PaginationDto, toSkipTake } from './pagination.dto';

function build(query: Record<string, unknown>) {
  const dto = plainToInstance(PaginationDto, query);
  return { dto, errors: validateSync(dto) };
}

describe('PaginationDto', () => {
  it('usa page=1 y limit=20 por defecto', () => {
    const { dto, errors } = build({});
    expect(errors).toHaveLength(0);
    expect(dto).toMatchObject({ page: 1, limit: 20 });
  });

  it('convierte los query params de texto a número', () => {
    const { dto, errors } = build({ page: '3', limit: '50' });
    expect(errors).toHaveLength(0);
    expect(dto).toMatchObject({ page: 3, limit: 50 });
  });

  it.each([{ limit: '101' }, { limit: '0' }, { page: '0' }, { page: 'abc' }])(
    'rechaza valores fuera de rango: %o',
    (query) => {
      expect(build(query).errors.length).toBeGreaterThan(0);
    },
  );

  it('calcula skip/take y la metadata', () => {
    const { dto } = build({ page: '2', limit: '10' });
    expect(toSkipTake(dto)).toEqual({ skip: 10, take: 10 });
    expect(paginate(['a'], 21, dto).meta).toEqual({
      page: 2,
      limit: 10,
      total: 21,
      totalPages: 3,
    });
  });
});
