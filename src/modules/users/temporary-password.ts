import { randomInt } from 'crypto';
import { isStrongPassword } from '../../common/validators/password-policy';

// Sin caracteres que se confunden al dictarla o copiarla (0/O, 1/l/I).
const LOWER = 'abcdefghijkmnpqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '*#$%&@+?!';
const ALL = LOWER + UPPER + DIGITS + SYMBOLS;

export const TEMPORARY_PASSWORD_LENGTH = 14;

const pick = (chars: string): string => chars[randomInt(chars.length)];

/**
 * Contraseña temporal aleatoria (CSPRNG) que cumple la política: al menos una
 * minúscula, una mayúscula, un número y un símbolo, en posiciones al azar.
 */
export function generateTemporaryPassword(): string {
  const chars = [pick(LOWER), pick(UPPER), pick(DIGITS), pick(SYMBOLS)];
  while (chars.length < TEMPORARY_PASSWORD_LENGTH) chars.push(pick(ALL));
  // Fisher-Yates con randomInt: los obligatorios no quedan siempre al inicio.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  const password = chars.join('');
  if (!isStrongPassword(password)) {
    throw new Error('La contraseña temporal no cumple la política');
  }
  return password;
}
