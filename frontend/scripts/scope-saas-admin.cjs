const fs = require('fs')
const path = require('path')

const src = path.join(__dirname, '../src/styles/saas-admin.css')
const out = path.join(__dirname, '../src/admin/styles/saas-admin.css')
const lines = fs.readFileSync(src, 'utf8').split(/\r?\n/)
const outLines = []
let inKeyframes = false

for (const line of lines) {
  let l = line
  if (/^@keyframes/.test(l.trim())) inKeyframes = true
  if (inKeyframes && /^\}/.test(l.trim())) inKeyframes = false

  if (/^:root\s*\{/.test(l)) {
    l = l.replace(':root', '.saas-admin')
  } else if (!inKeyframes && /^\.saas-/.test(l) && !l.includes('.saas-admin ')) {
    l = `.saas-admin ${l}`
  } else if (/^  \./.test(l) && l.includes('saas-') && !l.includes('.saas-admin ')) {
    // indented sub-selectors in @media
    l = l.replace(/^(\s+)\./, '$1.saas-admin .')
  }

  outLines.push(l)
}

fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, `/* Scoped under .saas-admin */\n\n${outLines.join('\n')}\n`)
console.log('ok', out)
