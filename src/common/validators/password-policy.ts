/**
 * Política mínima de contraseñas: 10 a 72 caracteres (bcrypt ignora más allá de 72 bytes),
 * con mayúscula, minúscula, número y símbolo.
 */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 72;
export const PASSWORD_REGEX =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).+$/;
export const PASSWORD_POLICY_MESSAGE =
  'La contraseña debe tener entre 10 y 72 caracteres e incluir mayúscula, minúscula, número y símbolo';

export const BCRYPT_COST = 12;

export function isStrongPassword(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length >= PASSWORD_MIN_LENGTH &&
    Buffer.byteLength(value, 'utf8') <= PASSWORD_MAX_LENGTH &&
    PASSWORD_REGEX.test(value)
  );
}
