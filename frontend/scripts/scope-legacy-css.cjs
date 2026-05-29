const fs = require('fs')
const path = require('path')

const file = path.join(__dirname, '../src/legacy/styles/legacy-dashboard.css')
let css = fs.readFileSync(file, 'utf8')

css = css.replace(/html\.legacy-dashboard-route/g, '.legacy-dashboard')
css =
  '/* Legacy BI — scoped under .legacy-dashboard */\n\n' +
  css +
  '\n\n/* html/body height when legacy route active */\n' +
  'html.legacy-dashboard-route,\n' +
  'html.legacy-dashboard-route body,\n' +
  'html.legacy-dashboard-route #root {\n' +
  '  width: 100%;\n' +
  '  max-width: 100%;\n' +
  '  overflow-x: hidden;\n' +
  '  height: 100%;\n' +
  '}\n'

fs.writeFileSync(file, css)
console.log('scoped legacy-dashboard.css')
