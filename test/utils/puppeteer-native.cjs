/**
 * Puppeteer 25 solo se publica como ESM. Node 22 lo carga con require (la
 * aplicación no necesita nada), pero el registro de módulos de Jest 29 no:
 * en las pruebas se carga con el require nativo de Node, fuera de Jest.
 */
const { createRequire } = process.getBuiltinModule('module');

module.exports = createRequire(__filename)('puppeteer');
