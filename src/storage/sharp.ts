/**
 * sharp en CommonJS exporta la función directamente (sin `.default`), pero con
 * la resolución de módulos de este proyecto TypeScript lee sus tipos ESM
 * (`export default`). Este puente une ambos: tipo correcto y valor real.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const sharp = require('sharp') as typeof import('sharp').default;
