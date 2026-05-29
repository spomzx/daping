/**
 * 拆分并作用域 App.css → legacy-app.css + admin-app-legacy.css
 * 作用域 page CSS → .saas-admin 前缀
 */
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')

function prefixSelectorBlock(selectors, prefix) {
  return selectors
    .split(',')
    .map((s) => {
      const t = s.trim()
      if (!t) return t
      if (t.includes(prefix.trim())) return t
      return `${prefix} ${t}`
    })
    .join(', ')
}

function classifyPrefix(selector) {
  const s = selector.trim()
  if (/analytics-route/.test(s)) return null
  if (/shop-mgmt|\.analytics-|analytics-page/.test(s)) return '.saas-admin'
  if (/^html\s*,|^html,|^body\s*,|#root/.test(s) && !/legacy-dashboard/.test(s)) {
    return 'LEGACY_HTML'
  }
  if (/^\.app\s*,/.test(s)) return 'SKIP'
  if (/^\*\s*,|^\*,|^\*\s*::/.test(s)) return 'GLOBAL'
  return '.legacy-dashboard'
}

function processCssFile(inputPath, options = {}) {
  const { defaultPrefix = null, skipAnalyticsRoute = false } = options
  const css = fs.readFileSync(inputPath, 'utf8')
  const out = []
  let i = 0
  let inKeyframes = false

  while (i < css.length) {
    const rest = css.slice(i)
    const comment = rest.match(/^\/\*[\s\S]*?\*\//)
    if (comment) {
      out.push(comment[0])
      i += comment[0].length
      continue
    }
    const atRule = rest.match(/^@(keyframes|media)[\s\S]*?\{/)
    if (atRule) {
      const kind = atRule[1]
      const start = i
      i += atRule[0].length
      let depth = 1
      while (i < css.length && depth > 0) {
        if (css[i] === '{') depth++
        if (css[i] === '}') depth--
        i++
      }
      let block = css.slice(start, i)
      if (kind === 'media') {
        block = block.replace(/(^|\})\s*([^@{}][^{]*)\{/gm, (full, brace, sel) => {
          const trimmed = sel.trim()
          if (!trimmed) return full
          const p = defaultPrefix || classifyPrefix(trimmed)
          if (p === null || p === 'GLOBAL' || p === 'SKIP' || p === 'LEGACY_HTML') return full
          if (p === 'LEGACY_HTML') return full
          return `${brace}\n${prefixSelectorBlock(trimmed, p)} {`
        })
      }
      out.push(block)
      continue
    }
    const rule = rest.match(/^([^@{}][^{]*)\{/)
    if (!rule) {
      out.push(rest[0])
      i++
      continue
    }
    const selectors = rule[1].trim()
    i += rule[0].length
    let depth = 1
    const bodyStart = i
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++
      if (css[i] === '}') depth--
      i++
    }
    const body = css.slice(bodyStart, i - 1)

    if (/^@keyframes/.test(selectors)) {
      inKeyframes = true
      out.push(`${selectors}{${body}}`)
      inKeyframes = false
      continue
    }

    let prefix = defaultPrefix
    if (prefix === null) prefix = classifyPrefix(selectors)

    if (skipAnalyticsRoute && /analytics-route/.test(selectors)) {
      out.push(`${selectors}{${body}}`)
      continue
    }

    if (prefix === 'GLOBAL' || prefix === 'SKIP') {
      out.push(`${selectors}{${body}}`)
    } else if (prefix === 'LEGACY_HTML') {
      out.push(
        `html.legacy-dashboard-route,\nhtml.legacy-dashboard-route body,\nhtml.legacy-dashboard-route #root{${body}}`,
      )
    } else if (prefix === null) {
      out.push(`${selectors}{${body}}`)
    } else {
      out.push(`${prefixSelectorBlock(selectors, prefix)}{${body}}`)
    }
  }
  return out.join('')
}

// 1. Split App.css
const appCss = path.join(root, 'src/App.css')
const legacyOut = path.join(root, 'src/legacy/styles/legacy-app.css')
const adminAppOut = path.join(root, 'src/admin/styles/admin-app-legacy.css')

const appContent = fs.readFileSync(appCss, 'utf8')
const legacyParts = []
const adminParts = []
let i = 0
while (i < appContent.length) {
  const rest = appContent.slice(i)
  const comment = rest.match(/^\/\*[\s\S]*?\*\//)
  if (comment) {
    legacyParts.push(comment[0])
    adminParts.push(comment[0])
    i += comment[0].length
    continue
  }
  const atM = rest.match(/^@media[^{]*\{/)
  if (atM) {
    const start = i
    i += atM[0].length
    let depth = 1
    while (i < appContent.length && depth > 0) {
      if (appContent[i] === '{') depth++
      if (appContent[i] === '}') depth--
      i++
    }
    const block = appContent.slice(start, i)
    legacyParts.push(
      block.replace(/(^|\})\s*([^@{}][^{]*)\{/gm, (full, brace, sel) => {
        const p = classifyPrefix(sel.trim())
        if (p === '.saas-admin') {
          adminParts.push(`${brace}\n${prefixSelectorBlock(sel.trim(), p)}{`)
          return '/* moved to admin */'
        }
        if (p === null || p === 'LEGACY_HTML') return full
        if (p === 'GLOBAL' || p === 'SKIP') return full
        return `${brace}\n${prefixSelectorBlock(sel.trim(), p)}{`
      }),
    )
    continue
  }
  const rule = rest.match(/^([^@{}][^{]*)\{/)
  if (!rule) {
    legacyParts.push(rest[0])
    adminParts.push(rest[0])
    i++
    continue
  }
  const selectors = rule[1].trim()
  i += rule[0].length
  let depth = 1
  const bodyStart = i
  while (i < appContent.length && depth > 0) {
    if (appContent[i] === '{') depth++
    if (appContent[i] === '}') depth--
    i++
  }
  const body = appContent.slice(bodyStart, i - 1)
  const p = classifyPrefix(selectors)
  if (p === '.saas-admin') {
    adminParts.push(`${prefixSelectorBlock(selectors, p)}{${body}}`)
  } else if (p === 'LEGACY_HTML') {
    legacyParts.push(
      `html.legacy-dashboard-route,\nhtml.legacy-dashboard-route body,\nhtml.legacy-dashboard-route #root{${body}}`,
    )
  } else if (p === null) {
    adminParts.push(`${selectors}{${body}}`)
  } else if (p === 'GLOBAL' || p === 'SKIP') {
    legacyParts.push(`${selectors}{${body}}`)
  } else {
    legacyParts.push(`${prefixSelectorBlock(selectors, p)}{${body}}`)
  }
}

fs.mkdirSync(path.dirname(legacyOut), { recursive: true })
fs.writeFileSync(
  legacyOut,
  `/* Legacy BI war-room — 所有规则限定在 .legacy-dashboard 内 */\n\n${legacyParts.join('')}\n`,
)
fs.writeFileSync(
  adminAppOut,
  `/* SaaS Admin：自 App.css 迁出的 shop-mgmt / analytics 规则 */\n\n${adminParts.join('')}\n`,
)
console.log('wrote', legacyOut, adminAppOut)

// 2. Scope page CSS files
const pageFiles = [
  ['src/pages/SyncCenter/sync-center.css', 'src/admin/styles/admin-sync.css'],
  ['src/pages/Users/users-page.css', 'src/admin/styles/admin-users.css'],
  ['src/pages/Tenants/tenants-page.css', 'src/admin/styles/admin-tenants.css'],
  ['src/pages/Shops/shops-page.css', 'src/admin/styles/admin-shops.css'],
]

for (const [relIn, relOut] of pageFiles) {
  const scoped = processCssFile(path.join(root, relIn), { defaultPrefix: '.saas-admin' })
  fs.mkdirSync(path.dirname(path.join(root, relOut)), { recursive: true })
  fs.writeFileSync(path.join(root, relOut), `/* Scoped: .saas-admin */\n\n${scoped}\n`)
  console.log('scoped', relOut)
}

// 3. Fix admin-layout from saas-layout source
const layoutSrc = path.join(root, 'src/components/layout/saas-layout.css')
const layoutLines = fs.readFileSync(layoutSrc, 'utf8').split(/\r?\n/)
const layoutOut = []
let inMedia = false
for (const line of layoutLines) {
  const t = line.trim()
  if (t.startsWith('@media')) {
    inMedia = true
    layoutOut.push(line)
    continue
  }
  if (inMedia && t === '}') {
    inMedia = false
    layoutOut.push(line)
    continue
  }
  if (/^\.saas-/.test(t) && t.includes('{')) {
    layoutOut.push(`.saas-admin ${t}`)
  } else if (inMedia && /^\.saas-/.test(t)) {
    layoutOut.push(line.replace(/^(\s*)\./, '$1.saas-admin .'))
  } else {
    layoutOut.push(line)
  }
}
fs.writeFileSync(
  path.join(root, 'src/admin/styles/admin-layout.css'),
  `/* SaaS shell layout — scoped */\n\n${layoutOut.join('\n')}\n`,
)
console.log('fixed admin-layout.css')
