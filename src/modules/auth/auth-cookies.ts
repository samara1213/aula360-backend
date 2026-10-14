import { CookieOptions, Request, Response } from 'express';

/** El refresh token solo viaja a las rutas de autenticación. */
export const REFRESH_COOKIE_PATH = '/api/auth';

/**
 * Nombres de cookie. Con secure (producción) llevan prefijo:
 * - __Host-: exige secure, path=/ y sin domain (un subdominio no puede sobrescribirla).
 * - __Secure-: exige secure (el refresh usa path=/api/auth, incompatible con __Host-).
 */
export function accessCookieName(secure: boolean): string {
  return secure ? '__Host-access_token' : 'access_token';
}

export function refreshCookieName(secure: boolean): string {
  return secure ? '__Secure-refresh_token' : 'refresh_token';
}

export function readCookie(req: Request, name: string): string | undefined {
  return (req.cookies as Record<string, string> | undefined)?.[name];
}

export interface AuthCookieSettings {
  secure: boolean;
  /** Vida de ambas cookies (la del refresh token). */
  maxAgeMs: number;
}

function baseOptions(secure: boolean, path: string): CookieOptions {
  return { httpOnly: true, secure, sameSite: 'lax', path };
}

/**
 * La cookie del access token vive lo mismo que el refresh token: el JWT expira
 * a los 15 min, pero /auth/refresh-token lo necesita (aunque esté vencido) para
 * conservar la institución activa al rotar.
 */
export function setAuthCookies(
  res: Response,
  tokens: { accessToken: string; refreshToken: string },
  settings: AuthCookieSettings,
): void {
  setAccessCookie(res, tokens.accessToken, settings);
  res.cookie(refreshCookieName(settings.secure), tokens.refreshToken, {
    ...baseOptions(settings.secure, REFRESH_COOKIE_PATH),
    maxAge: settings.maxAgeMs,
  });
}

export function setAccessCookie(
  res: Response,
  accessToken: string,
  { secure, maxAgeMs }: AuthCookieSettings,
): void {
  res.cookie(accessCookieName(secure), accessToken, {
    ...baseOptions(secure, '/'),
    maxAge: maxAgeMs,
  });
}

/** clearCookie con las mismas opciones de path/sameSite/secure con que se crearon. */
export function clearAuthCookies(res: Response, secure: boolean): void {
  res.clearCookie(accessCookieName(secure), baseOptions(secure, '/'));
  res.clearCookie(
    refreshCookieName(secure),
    baseOptions(secure, REFRESH_COOKIE_PATH),
  );
}
