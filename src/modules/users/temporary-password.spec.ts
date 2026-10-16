import { isStrongPassword } from '../../common/validators/password-policy';
import {
  generateTemporaryPassword,
  TEMPORARY_PASSWORD_LENGTH,
} from './temporary-password';

describe('generateTemporaryPassword', () => {
  it('cumple la política y tiene la longitud fija', () => {
    for (let i = 0; i < 500; i++) {
      const password = generateTemporaryPassword();
      expect(password).toHaveLength(TEMPORARY_PASSWORD_LENGTH);
      expect(isStrongPassword(password)).toBe(true);
    }
  });

  it('no usa caracteres que se confunden (0, O, 1, l, I)', () => {
    const all = Array.from({ length: 200 }, generateTemporaryPassword).join('');
    expect(all).not.toMatch(/[0O1lI]/);
  });

  it('no se repite', () => {
    const passwords = new Set(
      Array.from({ length: 200 }, generateTemporaryPassword),
    );
    expect(passwords.size).toBe(200);
  });
});
