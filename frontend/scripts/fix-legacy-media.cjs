const fs = require('fs')
const path = require('path')

const file = path.join(__dirname, '../src/legacy/styles/legacy-app.css')
let css = fs.readFileSync(file, 'utf8')

css = css.replace(/\.legacy-dashboard\s+@media/g, '@media')

css = css.replace(/@media[^{]+\{([\s\S]*?)\n\}/g, (block, inner) => {
  const fixed = inner.replace(/(^|\})\s*([^@{}][^{]*)\{/gm, (full, brace, sel) => {
    const trimmed = sel.trim()
    if (!trimmed || trimmed.includes('.legacy-dashboard') || trimmed.startsWith('@')) return full
    if (trimmed.startsWith('html.legacy-dashboard-route')) return full
    return `${brace}\n.legacy-dashboard ${trimmed} {`
  })
  return block.replace(inner, fixed)
})

fs.writeFileSync(file, css)
console.log('fixed @media in legacy-app.css')
