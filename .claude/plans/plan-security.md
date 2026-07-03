# Implementation Plan: Phase 3 Security Hardening

## Overview

Add four security hardening items to the Dharma Farms Express application: rate limiting on admin login, Helmet security headers, log sanitization for customer tokens, and a user-facing 500 error page. These address findings 5, 8, 9, and 10 from the Architecture Validation section of the PRD.

## Requirements

- Rate limit POST /admin/login to 5 attempts per minute per IP (in-memory)
- Apply Helmet security headers to all responses
- Sanitize customer portal token segments (`/my-account/<64-char-hex>`) from logged request URLs
- Render a 500.ejs template for HTML requests instead of returning JSON-only errors
- All changes must be testable via existing node:test test patterns
- No breaking changes to existing middleware order or route behavior

## Architecture Changes

- **server.js**: Add three new middleware layers (Helmet, log sanitizer, rate limiter config) and update the error handler
- **routes/admin.js**: Apply the rate limiter middleware to POST /admin/login
- **views/errors/500.ejs** (new): User-friendly error page matching 404.ejs style
- **package.json**: Add `helmet` and `express-rate-limit` dependencies

## Files to Create or Modify

| Action | File |
|--------|------|
| Modify | `package.json` |
| Modify | `server.js` |
| Modify | `routes/admin.js` |
| Create | `views/errors/500.ejs` |
| Modify | `test/server.test.js` |

## Implementation Steps

### Phase 1: Install Dependencies

1. **Install helmet and express-rate-limit** (package.json)
   - Action: Run `npm install helmet express-rate-limit`
   - Result: Both packages added to `dependencies` in package.json
   - Version notes: Install latest versions compatible with Express 5. express-rate-limit v7.x has native Express 5 support. Helmet v8.x works with Express 5.
   - Dependencies: None
   - Risk: Low — both are stable, widely-used middleware

### Phase 2: Middleware Changes in server.js

2. **Add Helmet middleware** (File: `server.js`)
   - Import: Add `const helmet = require('helmet');` to the module imports block (after line 21 with other requires)
   - Insertion point in `createApp()`: Add `app.use(helmet());` immediately after `const app = express();` (line 147) and before body parsing (line 149)
   - Why: Helmet sets security headers (X-Content-Type-Options, X-Frame-Options, etc.) on every response. It must be the first middleware so headers are set before any route processing.
   - Why default helmet() is sufficient: The app has no inline scripts, no frames, no custom CSP needs. Default helmet enables X-XSS-Protection, X-Content-Type-Options: nosniff, X-Frame-Options: SAMEORIGIN, and other safe defaults.
   - Dependencies: Step 1 (helmet must be installed)
   - Risk: Low

3. **Add log sanitization middleware** (File: `server.js`)
   - Insertion point in `createApp()`: After Helmet (step 2), before body parsing (line 149)
   - Purpose: Intercepts requests and replaces `/my-account/<64-char-hex>` token segments in `req.originalUrl` with `/my-account/[REDACTED]` so customer tokens never appear in logs or error output
   - Implementation:

     ```javascript
     // ── Log sanitization ──────────────────────────────────────────────
     /**
      * Replaces /my-account/<64-char-hex> with /my-account/[REDACTED]
      * so customer tokens never appear in server logs or error output.
      * Route handlers must read the token from req.params, not req.originalUrl.
      */
     app.use((req, res, next) => {
       if (req.originalUrl && /\/my-account\/[a-f0-9]{64}/i.test(req.originalUrl)) {
         req.originalUrl = req.originalUrl.replace(
           /(\/my-account\/)[a-f0-9]{64}/gi,
           '$1[REDACTED]'
         );
         req.url = req.originalUrl;
       }
       next();
     });
     ```

   - Why: PRD section 8.1 finding 9 requires tokens never appear in logs. Runs on every request before any handler.
   - Edge case: Token preserved in `req.params` for route handlers — only `req.originalUrl` and `req.url` are sanitized (used by 404 handler and error logger).
   - Dependencies: None (pure JS, no external packages)
   - Risk: Low — regex is specific to 64-char hex tokens with `/my-account/` prefix

4. **Add rate limiter configuration** (File: `server.js`)
   - Import: Add `const rateLimit = require('express-rate-limit');` to module imports
   - Insertion point in `createApp()`: After session middleware block (after line 180 `});`) and before `app.locals.adminPasswordHash` (line 184)
   - Implementation:

     ```javascript
     // ── Rate limiting ──────────────────────────────────────────────────
     const loginLimiter = rateLimit({
       windowMs: 60 * 1000,  // 1 minute window
       max: 5,                // 5 attempts per window per IP
       standardHeaders: true, // Return rate limit info in RateLimit-* headers
       legacyHeaders: false,  // Disable X-RateLimit-* headers
       message: { error: 'Too many login attempts. Try again in a minute.' },
     });
     app.locals.loginLimiter = loginLimiter;
     ```

   - Why: Instantiated once and shared via app.locals so `setupAdminRoutes` (which receives `app`) can apply it per-route.
   - Dependencies: Step 1 (express-rate-limit must be installed)
   - Risk: Low. express-rate-limit v7.x supports Express 5. In-memory store is fine for single-process PM2 deployment.

### Phase 3: Route and View Changes

5. **Apply rate limiter to POST /admin/login** (File: `routes/admin.js`, line 75)
   - Change: Add `app.locals.loginLimiter` as middleware before the route handler
   - Before (line 75):
     ```javascript
     app.post('/admin/login', (req, res) => {
     ```
   - After:
     ```javascript
     app.post('/admin/login', app.locals.loginLimiter, (req, res) => {
     ```
   - Why: This is the only endpoint needing rate limiting. The limiter is already in app.locals.
   - Dependencies: Step 4 (loginLimiter in app.locals)
   - Risk: Low

6. **Update 500 error handler** (File: `server.js`, lines 200-210)
   - Change: Modify the error middleware to check `req.accepts('html')` (same pattern as the 404 handler) and render `errors/500` for HTML requests
   - Replace lines 200-210:

     ```javascript
     // ── Error middleware ──────────────────────────────────────────────
     app.use((err, req, res, _next) => {
       const sanitizedUrl = req.originalUrl;
       console.error('[Server] Unhandled error on', sanitizedUrl + ':', err.message);
       console.error(err.stack);
       if (req.accepts('html')) {
         res.status(500).render('errors/500', { url: sanitizedUrl });
       } else {
         res.status(500).json({
           error: 'Internal server error',
           message: process.env.NODE_ENV === 'development' ? err.message : undefined,
         });
       }
     });
     ```

   - Why: Currently returns JSON for all requests. HTML clients get a raw JSON response instead of a user-friendly page.
   - `sanitizedUrl` is already sanitized by the step 3 middleware.
   - Dependencies: Step 7 (500.ejs must exist)
   - Risk: Low

7. **Create views/errors/500.ejs** (File: `views/errors/500.ejs`)
   - Create the `views/errors/` directory and write the template matching the existing 404.ejs style
   - Template content:

     ```ejs
     <!DOCTYPE html>
     <html lang="en">
     <head>
       <meta charset="UTF-8">
       <meta name="viewport" content="width=device-width, initial-scale=1.0">
       <title>500 — Server Error | Dharma Farms</title>
       <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
       <link rel="stylesheet" href="/css/style.css">
     </head>
     <body class="bg-[#F0FDF4] min-h-screen flex items-center justify-center p-4">
       <div class="text-center max-w-md">
         <h1 class="text-6xl font-bold text-[#1B4332] mb-4">500</h1>
         <p class="text-xl text-gray-600 mb-2">Something went wrong</p>
         <p class="text-sm text-gray-400 mb-6">
           An unexpected error occurred. Please try again or contact the admin.
         </p>
         <p class="text-xs text-gray-300 mb-6">
           <%%= typeof url !== 'undefined' ? url : '' %>
         </p>
         <a href="/admin/login" class="inline-block bg-[#2D6A4F] hover:bg-[#1B4332] text-white font-medium py-2.5 px-6 rounded-lg transition-colors duration-150">
           Go to Login
         </a>
       </div>
     </body>
     </html>
     ```

   - Dependencies: None (standalone template file)
   - Risk: Low

### Phase 4: Testing

8. **Test Helmet headers** (File: `test/server.test.js`)
   - Add inside `describe('Express app setup')` after the login page test
   - Test: Verify `x-content-type-options` and `x-frame-options` headers on GET /health

     ```javascript
     it('sets Helmet security headers', async () => {
       const res = await request(server, 'GET', '/health');
       assert.ok(res.headers['x-content-type-options'], 'Should have X-Content-Type-Options');
       assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
       assert.ok(res.headers['x-frame-options'], 'Should have X-Frame-Options');
       assert.strictEqual(res.headers['x-frame-options'], 'SAMEORIGIN');
     });
     ```

   - Dependencies: Step 2
   - Risk: Low

9. **Test rate limiting** (File: `test/server.test.js`)
   - Add new `describe('rate limiting')` block after the error handling section
   - Test: Send 6 POST /admin/login requests, assert first 5 return 302, 6th returns 429
   - Requires its own `before`/`after` with server instance (isolated rate limiter store)
   - Dependencies: Steps 4, 5
   - Risk: Low

10. **Test log sanitization** (File: `test/server.test.js`)
    - Add inside `describe('Express app setup')`
    - Test: GET /my-account/<64-char-hex> returns 404 (route not implemented yet) without crashing

      ```javascript
      it('sanitizes token URLs without crashing', async () => {
        const fakeToken = 'a'.repeat(64);
        const res = await request(server, 'GET', '/my-account/' + fakeToken);
        assert.strictEqual(res.status, 404, 'Should return 404 (route does not exist yet)');
      });
      ```

    - Dependencies: Step 3
    - Risk: Low

11. **Test 500 error page** (File: `test/server.test.js`)
    - Replace the existing `error handling` describe block
    - Add a second test that sends a request with `Accept: text/html` and verifies the response body contains "500"
    - The existing JSON test should send `Accept: application/json` explicitly
    - Dependencies: Steps 6, 7
    - Risk: Low

## Middleware Order (final createApp function)

```
 1. app.use(helmet())                        <- NEW (security headers)
 2. Log sanitizer middleware                 <- NEW (sanitize URLs)
 3. express.urlencoded / express.json        <- existing (body parsing)
 4. express.static                           <- existing (static files)
 5. EJS view engine setup                    <- existing
 6. express-session (SQLite-backed)          <- existing
 7. rateLimit config, app.locals storage     <- NEW (not mounted globally)
 8. app.locals.adminPasswordHash             <- existing
 9. setupAdminRoutes(app, db)                <- existing (rate limiter on login route)
10. 404 handler                              <- existing
11. Error middleware                         <- UPDATED (500.ejs for HTML)
```

## Dependency Graph

```
Step 1 (npm install)
  +-> Step 2 (Helmet) ---------> Step 8 (Helmet test)
  +-> Step 4 (rateLimiter) ----> Step 5 (apply) ----> Step 9 (rate limit test)
Step 3 (log sanitizer) ------------------------------> Step 10 (sanitizer test)
Step 7 (500.ejs) ---------------> Step 6 (handler) --> Step 11 (500 test)
```

Steps 2, 3, 4, and 7 are independent. Steps 5 and 6 depend on preceding steps.

## Testing Strategy

- **Automated**: Run `node --test test/server.test.js` — all existing tests must pass plus 5 new tests
- **Manual verification**:
  1. POST /admin/login 6 times with wrong password — 6th returns 429
  2. Check response headers from any page — x-content-type-options: nosniff present
  3. Browse to a non-existent route like /my-account/aaaa... (64 a's) — 404 page, no crash
  4. Temporarily add `throw new Error('test')` to a route, visit with browser — 500 page renders

## Risks and Mitigations

- **Risk**: express-rate-limit incompatible with Express 5
  - Mitigation: express-rate-limit v7.x supports Express 5 natively. Pin to `^7.0.0` if needed.
- **Risk**: Log sanitizer mutates req.originalUrl, breaking future route handlers
  - Mitigation: Future customer route handlers must read token from `req.params.token` (Express routing), not `req.originalUrl`. Document this in a code comment on the sanitizer middleware.
- **Risk**: Rate limiter state lost on PM2 restart (in-memory)
  - Mitigation: Acceptable for single-admin system. Restart after crash clears the counter — 5 fresh attempts allowed.
- **Risk**: views/errors/ directory not created (EJS template resolution fails)
  - Mitigation: Create the directory explicitly. EJS resolves templates from the views root; `res.render('errors/500')` looks for `views/errors/500.ejs`.

## Success Criteria

- [ ] `npm install helmet express-rate-limit` completes without errors
- [ ] GET /health returns x-content-type-options: nosniff and x-frame-options: SAMEORIGIN
- [ ] 6 rapid POST /admin/login with wrong password: first 5 return 302, 6th returns 429
- [ ] GET /my-account/<64-hex-chars> returns 404 without crashing or leaking the token in the response
- [ ] GET request with Accept: text/html to an error-throwing route renders 500.ejs (status 500, body contains "500")
- [ ] `node --test test/server.test.js` passes all tests
- [ ] No console.log statements in production code (console.error is acceptable for server logging)