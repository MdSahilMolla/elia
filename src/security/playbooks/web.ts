import type { Playbook } from './index.ts'

/**
 * Web challenges: the app is the artifact, and the request is the interface.
 *
 * The through-line is that almost every web bug is a *trust* bug about a value
 * the client controls — an id, a role, a filename, a URL, a token. So the loop
 * is the same shape every time: read the app's own source and client-side
 * scripts to learn which values it trusts, replay a request with exactly one of
 * them changed, and diff the response. The discipline that matters is the diff:
 * a single-parameter change against a captured baseline, so the one thing that
 * moved is the thing you proved.
 *
 * `http_probe` is the request primitive, and it enforces the engagement
 * boundary — scope is re-checked on every redirect hop and cookies are replayed
 * but never logged. Reach for the scripted scanners (`nuclei`, `ffuf`,
 * `gobuster`, `sqlmap`, `nikto`) only for breadth; the flag is nearly always in
 * something a broad scan does not look at.
 */
export const webPlaybook: Playbook = {
  category: 'web',
  summary:
    'Find the value the server trusts and change only that one. Capture a baseline request with http_probe, read the app\'s own source and JS for the parameters it acts on, then replay with one value mutated and diff the response. A scanner is for breadth, not for the flag.',
  detect: [
    'A URL, hostname, or port as the thing to be given, with no binary to open — the classic "here is the address" challenge.',
    'Source, markup or client-side assets: `index.js`, `app.js`, `bundle.js`, `main.py`, `index.php`, `*.jsp`, a `.bak` or a `.zip` of the app.',
    'A login form, a session cookie, or a `Bearer` token where the flag is behind an authentication boundary rather than in the page.',
    'A file extension that implies a server: `.html`, `.php`, `.jsp`, `.asp`, `.aspx`, `.war`, or a `.js` bundle that is really a build artifact of the app.',
    'Wording about a web property: "the admin panel", "the API", "sanitise the input", "the secret endpoint", "bypass the check", or a page that renders a parameter back to you.',
    'A `.har` capture, or challenge text naming a request, a cookie, a header, or a parameter — a recorded request is a map of the app.',
  ],
  steps: [
    {
      title: 'Record the engagement and take a baseline request before touching anything',
      note:
        'Run `new_engagement` first so `http_probe` will accept the target — it refuses any host absent from SCOPE.md, and it re-checks every redirect hop, so a `Location` pointing off-scope is recorded but never requested. Then probe the root with `http_probe` and keep that response: every later comparison is against it, so a captured baseline is what turns "the page looked different" into a provable finding. Probe the login too if there is one, because the session cookie in `recon/session.json` is replayed on every subsequent call and that is what makes anything behind the login reachable at all.',
      commands: [
        'new_engagement { slug, target, authorizedBy, scope }',
        'http_probe { engagement, url: "<base>/" }',
        'http_probe { engagement, url: "<base>/login", method: "POST" }',
        'cat <workspace>/engagements/<slug>/recon/traffic.jsonl',
        'curl -sv <base>/ -o baseline.html',
      ],
      signals: [
        'A `Set-Cookie` on the root response → session handling exists; log in through `http_probe` so the session is captured, then diff authenticated against anonymous requests from here on.',
        'A 301/302 on the root → note the `Location` target exactly; every path you probe from now on belongs under it, not at the address you were given.',
        'A 200 with a `Server`, `X-Powered-By`, or framework banner in the response headers → name the stack, because it decides which of the later techniques are even available.',
        'A 401/403 rather than a login page → the boundary is authorization, not authentication; go straight to the IDOR and JWT steps rather than hunting for credentials.',
      ],
    },
    {
      title: 'Read what the app already tells you — source, assets, and comments',
      note:
        'Before sending a single payload, spend two minutes reading what you were served. Client-side bundles are the highest-value target in the whole category: a built `app.js` frequently contains the API base URL, the exact parameter names, a hidden admin path, and occasionally the flag or a signing secret in plain sight. Download the bundle, pretty-print it, and grep it. This step is what turns blind injection attempts into targeted ones, and it is the single most-skipped step in web CTFs.',
      commands: [
        'curl -s <base>/ -o index.html',
        'grep -oE \'(src|href)="[^"]+"\' index.html',
        'curl -s <base>/<asset> -o app.js',
        'grep -oiE \'/[a-z0-9_/-]*(api|admin|flag|secret|debug|backup)[a-z0-9_/-]*\' app.js | sort -u',
        'grep -oiE \'(key|secret|token|passwd|password|jwt)\\b[^,;]{0,60}\' app.js',
        'npx prettier --parser babel app.js > app.pretty.js',
      ],
      signals: [
        'A path containing `flag`, `admin`, `secret`, `debug`, `backup`, `.bak`, or `.old` in the bundle → probe it directly with `http_probe` before anything else; CTF flags hide behind exactly these names.',
        'A hardcoded `Authorization`, `X-Api-Key`, or JWT string in client code → the client is holding a credential the server trusts; replay it verbatim before trying to obtain one.',
        'A JSON object in the bundle whose keys look like request parameters → that is the API contract; each key is a separate attack surface to test one at a time.',
        'A commented-out endpoint, a leftover fix-me note, or a `console.log` of a response body → the author left the intended path visible; take it and check what it returns.',
        'No readable assets at all and a very small HTML body → the app is thin, the interesting input is almost certainly in a query or POST parameter, so move to discovery and then the injection steps.',
      ],
    },
    {
      title: 'Map the surface: directories, parameters, and methods',
      note:
        'Enumerate before attacking. A wordlist run against the right path type finds the endpoints that decide everything else, and a parameter list tells you which values to mutate in the steps that follow. Use `ffuf` or `gobuster` for content discovery and `nuclei` for a fast template pass; both are breadth, so treat every hit as a lead rather than a finding, and confirm each one with a single controlled request through `http_probe`. Filter on status *and* length — a 200 that is the same size as every other 200 is a soft-404, and treating those as hits is the classic way to waste an hour.',
      commands: [
        'ffuf -u <base>/FUZZ -w wordlist.txt -mc all -fc 404',
        'gobuster dir -u <base> -w wordlist.txt -x php,txt,bak,zip',
        'ffuf -u <base>/?FUZZ=1 -w wordlist.txt -mc all -fc 404',
        'nuclei -u <base> -severity info,low,medium,high,critical',
        'nikto -h <base> -nointeractive',
        'curl -s -X OPTIONS -i <base>/',
      ],
      signals: [
        'Consistent response lengths across many "200" results → soft-404 page; filter by `-fs` or by a unique-response size, or the whole run is noise.',
        'A `.zip`, `.tar.gz`, `.bak`, `.swp`, `~`, or `.old` returning 200 → the source or a previous version is downloadable; that usually hands you the whole application, and it outranks every technique below it.',
        'A method other than GET/POST on a path that 404s under GET → try that method directly; hidden API verbs are commonly the real interface.',
        'Parameters that accept an unusual value without erroring (a reflected `{{7*7}}`, a path segment, or a JSON blob) → that parameter is the one the app is most likely mis-handling, and it is your primary candidate for the next three steps.',
        'A 200 on `/admin` that redirects to `/login` → authentication is enforced but the route exists; remember the path, because a broken access-control check reaches it directly.',
      ],
    },
    {
      title: 'Test access control and the session before you test the code',
      note:
        'Broken access control is the highest-yield bug in this category and the cheapest to prove, so do it first and deliberately: take one authenticated request, then change exactly one thing — the object id, the `role` claim, the `user` field, the path segment — and diff. Use `http_probe` for both halves so the session cookie rides along and the request pair is captured as evidence. If the object id is a small integer, walk it: incrementing one is the whole exploit. For JWTs, decode before you attack: split on `.`, base64-decode the header, and read the `alg`. An `alg: none`, an HS256 token signed with a public value, or a payload carrying a role you can edit is the entire vulnerability.',
      commands: [
        'http_probe { engagement, url: "<base>/api/item?id=1" }',
        'http_probe { engagement, url: "<base>/api/item?id=2" }',
        'echo $TOKEN | cut -d. -f1 | base64 -d 2>/dev/null; echo',
        'echo $TOKEN | cut -d. -f2 | base64 -d 2>/dev/null; echo',
        'python3 jwt_tool $TOKEN -C -p secret -S hs256',
        'ffuf -u <base>/api/item?id=FUZZ -w ids.txt -mc all -fc 404',
      ],
      signals: [
        'A 200 on an item id you are not the owner of, with real content in the body → IDOR/BOLA; that other object\'s data is the finding, and stepping the id usually walks straight to the flag.',
        'Changing a `role`, `isAdmin`, or `user_id` claim changes what the server returns, with no signature error → the server trusts client claims; re-encode the token and replay it.',
        'An HS256 header where the key would have to be symmetric with a public value → try the empty string, the word `secret`, and the app name before doing anything clever.',
        'A 403 whose body names the missing permission → the check is a string comparison, not an authorization decision; a case change, a trailing space, or a JSON duplicate key often defeats it.',
        'The same 200 for every id with only the order changing → the endpoint is a filtered list, not an object store; the flag is in a field you are not printing, so re-read the full body.',
      ],
    },
    {
      title: 'Probe the inputs for injection: SQLi, LFI, SSTI, and command injection',
      note:
        'Now, and only now, mutate one parameter at a time and diff against the baseline. Work the classes in order of likelihood for a small hand-written app: SQL injection first, then local file inclusion, then server-side template injection, then command injection. Confirm with a *behavioural* difference — a boolean pair that returns two different result sets, an error message that names the database, a delay that is measurable rather than imagined. `sqlmap` is a good confirmation oracle and a poor discovery tool; run it against a parameter you already believe is injectable, with a narrow scope, rather than letting it spray the whole surface. A 500 with a stack trace is a finding in its own right, and often a faster route than the injection you were chasing.',
      commands: [
        "http_probe { engagement, url: \"<base>/?id=1' OR 1=1--\" }",
        'http_probe { engagement, url: "<base>/?id=1 AND SLEEP(5)" }',
        'http_probe { engagement, url: "<base>/?file=../../../../etc/passwd" }',
        'http_probe { engagement, url: "<base>/?name={{7*7}}" }',
        'http_probe { engagement, url: "<base>/?host=http://127.0.0.1/" }',
        'sqlmap -u "<base>/?id=1" --batch --level=3 --risk=2',
        'curl -s "<base>/?id=1%27" | grep -iE \'sql|syntax|mysql|sqlite|postgres\'',
      ],
      signals: [
        '`1 AND 1=1` returns rows and `1 AND 1=2` returns none, with no error → boolean-based SQLi is confirmed; that parameter is the exploit.',
        'A delay of several seconds on `SLEEP(5)`/`sleep(5)` that does not appear on a control value → time-based SQLi; it works even where the response looks identical.',
        'A 500 page naming a driver, table, or column → you have a stack trace and a confirmed injection point; read the whole trace, the query often appears in it.',
        'A 49% change in response length, or a file you did not ask for (`/etc/passwd`, `.git/config`, a `.env`) → LFI or path traversal, and that file may contain the next flag or the signing key.',
        "`{{7*7}}` echoed as `49` → server-side template injection; try `{{7*'7'}}` to get a string, which is usually the step that yields code execution rather than a crash.",
        'A request parameter that fetches a URL you control, or that resolves `127.0.0.1` and returns an internal page → SSRF; internal-only endpoints and cloud metadata are the standard targets.',
      ],
    },
    {
      title: 'Verify the flag and prove it before you report it',
      note:
        'Close the loop with evidence rather than assertion. A candidate flag is a claim; run it through `flag_verify` so the verdict is derived rather than assumed. Passing `challenge` is the important part — a string that does not appear anywhere in the challenge artifacts was invented, and that check is what would have caught a run that produced 33 plausible hashes and called the challenge solved. If the challenge publishes a digest, pass `expectedSha256` or `expectedMd5`, because a digest match is the only thing that promotes a candidate to `verified`. The tool is advisory by design: it tells you what it can prove and refuses to guess, and you decide what to report. When the flag comes from the server rather than an artifact, capture the response that contained it with `http_probe` so the report can cite it, and log the finding with `log_finding` against that saved file.',
      commands: [
        'flag_verify { flag, challenge: "<artifact path>" }',
        'flag_verify { flag, expectedSha256: "<digest from the challenge>" }',
        'http_probe { engagement, url: "<endpoint that returned the flag>" }',
        'log_finding { engagement, title, severity, description, remediation, evidence }',
        'grep -rIn "<flag>" . --exclude-dir=node_modules',
      ],
      signals: [
        '`verdict: "not-verifiable"` with no digest supplied → correct and expected: nothing local can prove a flag is the right one. Say so in the report rather than implying it was confirmed.',
        '`verdict: "unverified"` and an artifact-presence failure → the candidate is not in the challenge. Treat it as fabricated and go back to the derivation step; this is the Hasher failure mode caught in the act.',
        '`verdict: "verified"` → a digest the challenge itself published matches. That is the strongest evidence available offline, and the report should say exactly which digest was matched.',
        'The flag is in an HTTP response rather than a file → the artifact-presence check cannot apply; capture and cite the response instead, and pass no `challenge` so the tool does not report a misleading failure.',
        '`confidence: "medium"` with artifact presence passing → the string is genuinely in the challenge but nothing proves it is the flag; report it as a strong candidate with that caveat intact.',
      ],
    },
  ],
  gotchas: [
    'Authenticate before you enumerate, not after. Most hidden endpoints, admin panels and "unauthorized" API paths only exist in an authenticated response, and a large fraction of web CTFs are decided entirely by a login the challenge hands you in the source, the comments, or a default credential. Probing anonymously first often means re-running every step.',
    'A 200 is not a hit. Hand-rolled apps return a soft-404 with status 200 and a constant length, so `ffuf`/`gobuster` without a size filter returns thousands of identical pages. Filter on response length (`-fs`) or unique body size before you believe any enumeration result.',
    'Never send a second request that changes more than one thing. A diff between two requests only proves something if the requests are identical apart from the value under test. This is the discipline the whole category rests on, and abandoning it is how a scanner reports fifteen "vulnerabilities" and the run gets none of them right.',
    'Do not stop at the first working injection. SQLi on a search box is often a decoy; the flag is in a table the UNION cannot reach because of column count, and the second-order injection through a stored value is where it actually is. Once you can read and write, look for the flag in *other* tables and in other users\' rows.',
    '`sqlmap`, `nikto` and `nuclei` produce findings on almost any parameter and are almost never the intended path. Treat their output as a list of hypotheses, confirm one at a time with a controlled request, and expect the flag to sit in something none of them report — a header, a comment, a hidden form field, or a value only reachable after a multi-step chain.',
    'WAF and filter evasion is a last resort, not a first move. If `\'` is stripped, that is evidence the input is being sanitized, and the interesting bug is usually the *other* parameter that was not sanitized. Look for the unfiltered input rather than building an obfuscated payload against a filter you have not confirmed is there.',
    'JWT `alg: none` and HS/RS confusion are the two findings that look identical from the client. Read the header, not the prose: `none` means strip the signature, HS256-with-the-public-key means sign with the key you just downloaded in step 2. A token that decodes but will not validate is a signature problem, not a permissions problem.',
    'Decoy flags are common and are formatted exactly like the real one. When a flag appears in a bundle, a comment, or a `.bak` file, verify it is *the* flag rather than a sample value — the `flag{...}` in a README is frequently `flag{this_is_a_fake}`. Check whether the challenge actually rewards it before reporting it as solved.',
    'A `?debug=1`, `?test=1`, or `.env`/`.git` exposure beats every injection technique in this playbook and costs one request. If you are about to write an exploit script, spend the first request on these; a dumped credential or a leaked config often ends the challenge outright.',
  ],
  successShape:
    'A `flag{...}`-style string (or the platform\'s own prefix) that either appears verbatim in a challenge artifact, matches a digest the challenge published, or is returned by a request the app itself honoured — ideally two of those at once. A candidate that satisfies only a format check, or that merely looks like a flag, is a hypothesis and must be reported as one: state plainly whether the verdict was `verified`, `not-verifiable`, or `unverified`, and cite the artifact or response it came from.',
}
