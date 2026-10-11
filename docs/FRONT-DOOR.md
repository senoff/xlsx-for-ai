# Front door: how a person gets into the product through this package

The product has several ways in: the Claude connector, the website and API, and this package (an MCP server and a terminal command). Every path a person can take into the product is specified, checked and alarmed in one place, the server repo:

- Spec: `docs/front-door-spec.md` in `senoff/xlsx-for-ai-server`. Each path has an id (FD-01 and up) with the exact request, the exact answer and what the person sees.
- Coverage run: `scripts/front-door-coverage.mjs` in that repo checks the spec against production and reports PASS, FAIL or NOT-CHECKABLE for every path.
- Sign-up alarm: `scripts/signup-alarm.mjs` in that repo watches new sign-ups per door, including the npm door, and raises an alert when a door goes quiet.

## What this package owns

| Spec id | What | Where it is checked |
| --- | --- | --- |
| FD-14 | The package is published and launchable from the npm registry | Server repo coverage run (reads the registry) |
| FD-27 | A brand-new person: first request shows a sign-in link and code in the chat, no terminal, no restart after approval | `test/v2/front-door-package.test.js` (real `index.js` and `mcp.js` against a local stand-in) |
| FD-28 | A returning person, a dead key, an old anonymous key, older versions | `test/v2/front-door-package.test.js`, `test/v2/login.test.js` and the other v2 tests |

The paths every door shares (the website, key sign-up, the API, error texts, limits) are in the server spec as FD-01 to FD-13 and FD-15 to FD-19, FD-29 to FD-33. They are not repeated here; change them there.

## The check only this package can make

`node scripts/front-door-check.js` packs the package the way it would be published, installs the tarball into an empty folder, and checks:

- PK-1: it installs.
- PK-2: both commands start. `xlsx-for-ai --version` prints this version, and `xlsx-for-ai-mcp` answers an MCP initialize and lists its tools with no key and no sign-in.
- PK-3: the version matches npm. `--mode=pre` (the default, for pull requests and releases in progress) passes when this version is the latest or newer. `--mode=post` (run after a release) passes only when this version is exactly what npm serves as latest. A mismatch after a release means the publish did not land.
- PK-4: the first-run sign-in text. The installed package shows the sentence a new person is meant to read ("xlsx-for-ai is free, and it needs a one-time sign-in before it can work on your spreadsheet."), the link and the code, and names no terminal.

The check starts no sign-in and calls no product endpoint. Its only network use is installing the package's own dependencies and one read of the npm registry. `--skip-registry` reports PK-3 as NOT-CHECKABLE for offline runs; that is not a pass.

The workflow `.github/workflows/front-door-check.yml` runs it on a daily schedule in `--mode=post`, and by hand. A red run is the signal that the npm door is broken for a new person.

## When you change the first-run experience

Change the spec in the server repo first (FD-27 or FD-28), then this package, then run both checks. If the sign-in sentence changes, update `NEW_PERSON_SENTENCE` in `scripts/front-door-check.js`; the unit test in `test/v2/front-door-check.test.js` fails until the two agree.
