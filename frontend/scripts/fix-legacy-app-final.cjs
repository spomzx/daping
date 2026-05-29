const fs = require('fs')
const path = require('path')

const file = path.join(__dirname, '../src/legacy/styles/legacy-app.css')
let css = fs.readFileSync(file, 'utf8')

css = css.replace(/\.legacy-dashboard\s+\/\*[\s\S]*?\*\/\s*/g, '/* shop-mgmt moved to admin */\n')

css = css.replace(/@media[^{]+\{([\s\S]*?)\}/g, (block, inner) => {
  const fixed = inner.replace(/(^|\})\s*([^{}@/][^{]*)\{/gm, (full, brace, sel) => {
    const t = sel.trim()
    if (!t || t.includes('.legacy-dashboard')) return full
    if (t.startsWith('/*')) return full
    return `${brace}\n.legacy-dashboard ${t} {`
  })
  return block.replace(inner, fixed)
})

fs.writeFileSync(file, css)
console.log('fixed legacy-app.css')
