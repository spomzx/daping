import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(__dirname, '../src/i18n.ts'), 'utf8')

function extract(locale) {
  const start = src.indexOf(`${locale}: {`)
  if (start < 0) throw new Error(`no ${locale}`)
  let i = src.indexOf('{', start)
  let depth = 0
  let j = i
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') {
      depth--
      if (depth === 0) {
        j++
        break
      }
    }
  }
  const block = src.slice(i, j)
  const obj = {}
  const re = /'([^']+)':\s*'((?:\\'|[^'])*)'/g
  let m
  while ((m = re.exec(block))) {
    obj[m[1]] = m[2].replace(/\\'/g, "'")
  }
  return obj
}

const outDir = path.join(__dirname, '../src/i18n')
fs.mkdirSync(outDir, { recursive: true })
for (const loc of ['zh', 'en', 'th']) {
  const o = extract(loc)
  fs.writeFileSync(path.join(outDir, `${loc}.json`), JSON.stringify(o, null, 2), 'utf8')
  console.log(loc, Object.keys(o).length)
}
