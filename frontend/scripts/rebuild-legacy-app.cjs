const fs = require('fs')
const path = require('path')

const appCss = fs.readFileSync(path.join(__dirname, '../src/App.css'), 'utf8')

/** 从 App.css 截取 legacy 段（排除 analytics / shop-mgmt 专用块） */
const cutAt = appCss.indexOf('/* Analytics：整页可滚动')
const warCss = cutAt > 0 ? appCss.slice(0, cutAt) : appCss

function prefixRuleSelectors(selectors, prefix) {
  return selectors
    .split(',')
    .map((s) => {
      const t = s.trim()
      if (!t) return t
      if (t.startsWith(prefix)) return t
      if (/^html\.legacy-dashboard-route/.test(t)) return t
      if (/^html\s*,|^html,|^body\s*,/.test(t)) {
        return 'html.legacy-dashboard-route, html.legacy-dashboard-route body, html.legacy-dashboard-route #root'
      }
      if (t === '*' || t.startsWith('*::')) return t
      if (/shop-mgmt|\.analytics-|analytics-page/.test(t)) return null
      return `${prefix} ${t}`
    })
    .filter(Boolean)
    .join(', ')
}

function transform(css, prefix) {
  const out = []
  let i = 0
  while (i < css.length) {
    const rest = css.slice(i)
    const comment = rest.match(/^\/\*[\s\S]*?\*\//)
    if (comment) {
      out.push(comment[0], '\n')
      i += comment[0].length
      continue
    }
    const at = rest.match(/^@(media|keyframes)[^{]*\{/)
    if (at) {
      const kind = at[1]
      const start = i
      i += at[0].length
      let depth = 1
      while (i < css.length && depth > 0) {
        if (css[i] === '{') depth++
        if (css[i] === '}') depth--
        i++
      }
      let block = css.slice(start, i)
      if (kind === 'media') {
        block = block.replace(/(^|\})\s*([^@{}][^{]*)\{/gm, (full, brace, sel) => {
          const next = prefixRuleSelectors(sel.trim(), prefix)
          if (!next) return '/* admin */'
          return `${brace}\n${next} {`
        })
        block = block.replace(/\/\* admin \*\/\s*/g, '')
      }
      out.push(block, '\n')
      continue
    }
    const rule = rest.match(/^([^@{}][^{]*)\{/)
    if (!rule) {
      out.push(rest[0])
      i++
      continue
    }
    const sel = rule[1].trim()
    i += rule[0].length
    let depth = 1
    const bodyStart = i
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++
      if (css[i] === '}') depth--
      i++
    }
    const body = css.slice(bodyStart, i - 1)
    const next = prefixRuleSelectors(sel, prefix)
    if (next) out.push(`${next}{${body}}\n`)
  }
  return out.join('')
}

let legacyCss =
  `/* Legacy BI — scoped under .legacy-dashboard */\n\n` + transform(warCss, '.legacy-dashboard')

legacyCss = legacyCss
  .replace(/\.legacy-dashboard\s+@media/g, '@media')
  .replace(/\.legacy-dashboard\s+@keyframes/g, '@keyframes')
  .replace(/\}\s*@media/g, '}\n@media')
  .replace(/\}\s*@keyframes/g, '}\n@keyframes')

const outPath = path.join(__dirname, '../src/legacy/styles/legacy-app.css')
fs.writeFileSync(outPath, legacyCss)
console.log('rebuilt', outPath, legacyCss.length)
