import { isStrongPassword } from './password-policy';

describe('isStrongPassword', () => {
  it('acepta una contraseña que cumple la política', () => {
    expect(isStrongPassword('Aula360*Segura')).toBe(true);
  });

  it.each([
    ['corta', 'Ab1*'],
    ['sin mayúscula', 'aula360*segura'],
    ['sin minúscula', 'AULA360*SEGURA'],
    ['sin número', 'Aula*Segura!!'],
    ['sin símbolo', 'Aula360Segura'],
    ['más de 72 bytes', `Aa1*${'x'.repeat(70)}`],
  ])('rechaza una contraseña %s', (_, password) => {
    expect(isStrongPassword(password)).toBe(false);
  });
});
