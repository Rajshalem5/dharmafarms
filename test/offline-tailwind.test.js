const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const TEMPLATE_DIR = path.join(__dirname, '..', 'views')
const PUBLIC_JS_DIR = path.join(__dirname, '..', 'public', 'js')
const SERVER_JS = path.join(__dirname, '..', 'server.js')

const CDN_URL = 'cdn.jsdelivr.net/npm/@tailwindcss/browser@4'
const LOCAL_PATH = '/js/tailwind.js'

const EJS_TEMPLATES = [
  path.join('admin', 'layout.ejs'),
  'login.ejs',
  '404.ejs',
  path.join('errors', '500.ejs'),
]

describe('Offline Tailwind CSS', () => {
  describe('Local tailwind.js file', () => {
    it('should exist at public/js/tailwind.js', () => {
      const filePath = path.join(PUBLIC_JS_DIR, 'tailwind.js')
      assert.ok(fs.existsSync(filePath), 'public/js/tailwind.js does not exist')
    })
  })

  describe('EJS templates use local file', () => {
    for (const template of EJS_TEMPLATES) {
      it(`${template} should reference /js/tailwind.js instead of CDN`, () => {
        const filePath = path.join(TEMPLATE_DIR, template)
        assert.ok(fs.existsSync(filePath), `Template ${template} not found`)

        const content = fs.readFileSync(filePath, 'utf-8')

        // Should NOT contain the CDN URL
        const hasCdn = content.includes(CDN_URL)
        assert.ok(!hasCdn, `${template} still references CDN: ${CDN_URL}`)

        // Should contain the local path
        const hasLocal = content.includes(`src="${LOCAL_PATH}"`)
        assert.ok(hasLocal, `${template} does not reference ${LOCAL_PATH}`)
      })
    }
  })

  describe('Helmet CSP in server.js', () => {
    it('should not include cdn.jsdelivr.net in scriptSrc', () => {
      assert.ok(fs.existsSync(SERVER_JS), 'server.js not found')
      const content = fs.readFileSync(SERVER_JS, 'utf-8')

      // Should not have cdn.jsdelivr.net anywhere in CSP
      const hasCdnInCsp = content.includes('cdn.jsdelivr.net')
      assert.ok(!hasCdnInCsp, 'server.js still references cdn.jsdelivr.net in CSP')
    })
  })
})