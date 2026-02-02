# AGENTS.md — OpenClaw Inspector

## Development Rules

### Testing
- After every change, run `npm test` to make sure all existing tests pass.
- Every new feature or bug fix must have test coverage before merging.
- Run `npx cypress run` for E2E tests when UI behavior changes.

### Documentation
- After every change, verify that README.md accurately reflects current functionality.
- If a feature was added, changed, or removed — update README accordingly.
- README is the public face of the project; it must always match what the code actually does.

### Build
- Run `npx vite build` after changes — must compile without errors.
- Restart `node server.js` after build to serve updated dist.

### Publishing
- After every change, ask the user if they want to publish a new version to npm.
- Bump version in package.json (`npm version patch/minor/major`), then `npm publish --otp=<code>`.
- User will provide the OTP code for npm 2FA.

### Workflow
1. Make changes
2. `npm test` — all tests pass
3. `npx vite build` — clean build
4. Manual verification on `http://localhost:9100`
5. `git commit` + `git push`
6. Update beads: `bd close` / `bd sync`
7. Ask user: "Publish to npm?"
