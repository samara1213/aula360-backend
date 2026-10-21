import { NextFunction, Request, Response } from 'express';
import { noStoreMiddleware } from './no-store.middleware';

describe('noStoreMiddleware', () => {
  it('fija Cache-Control: no-store y continúa', () => {
    const setHeader = jest.fn();
    const next = jest.fn() as NextFunction;
    noStoreMiddleware()(
      {} as Request,
      { setHeader } as unknown as Response,
      next,
    );
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(next).toHaveBeenCalled();
  });
});
