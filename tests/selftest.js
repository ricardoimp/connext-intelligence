// Executa os 18 cenarios obrigatorios do motor (node tests/selftest.js)
const CX = require('../public/engine.js');
const r = CX.selfTest();
r.forEach(x => console.log((x.ok ? 'OK   ' : 'FALHA') + '  ' + x.name + '  |  ' + x.detail + '  (' + x.ms + ' ms)'));
const f = r.filter(x => !x.ok).length;
console.log('\n' + (r.length - f) + ' de ' + r.length + ' aprovados');
process.exit(f ? 1 : 0);
