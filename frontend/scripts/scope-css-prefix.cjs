const fs = require('fs')
const path = require('path')

const prefix = process.argv[2] || '.saas-admin'
const inFile = process.argv[3]
const outFile = process.argv[4]

let css = fs.readFileSync(inFile, 'utf8')
css = css.replace(/(^|\})\s*([^@{}][^{]*)\{/gm, (full, brace, selectors) => {
  const trimmed = selectors.trim()
  if (!trimmed || trimmed.startsWith('@')) return full
  const scoped = trimmed
    .split(',')
    .map((part) => {
      const t = part.trim()
      if (!t) return t
      if (t.includes(prefix.trim())) return t
      if (t.startsWith('.')) return `${prefix} ${t}`
      return t
    })
    .join(', ')
  return `${brace}\n${scoped} {`
})
const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
css = css.replace(new RegExp(`${esc} ${esc} `, 'g'), `${prefix} `)
fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, css)
console.log('scoped', outFile)
