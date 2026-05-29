const fs = require('fs')
const p = 'src/legacy/LegacyDashboardPage.tsx'
let s = fs.readFileSync(p, 'utf8')
s = s.replace(/<motion\.div className="legacy-dashboard">/g, '<motion.div className="legacy-dashboard">')
const open = '<div className="legacy-dashboard">'
const close = '</' + 'motion.div>'
s = s.replace(/<motion\.div className="legacy-dashboard">/g, open)
s = s.replace(/<\/motion\.div>\s*\)\s*\}\s*$/m, '</motion.div>\n  )\n}')
// fix closing - find last </motion.div> before function end
const idx = s.lastIndexOf('</motion.div>')
if (idx > -1) {
  s = s.slice(0, idx) + '</motion.div>' + s.slice(idx + '</motion.div>'.length)
}
// simpler
s = fs.readFileSync(p, 'utf8')
s = s.replace('<motion.div className="legacy-dashboard">', '<div className="legacy-dashboard">')
const lastClose = s.lastIndexOf('</motion.div>')
if (lastClose > -1) s = s.slice(0, lastClose) + '</motion.div>' + s.slice(lastClose + 13)
s = s.replace('</motion.div>', '</motion.div>')
fs.writeFileSync(p, s)
