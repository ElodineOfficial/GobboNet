# Contributors

GobboNet is built with help from people who filed reports, dug into problems,
tested fixes, and wrote code. Many contributions arrived as pull requests that
were reimplemented rather than merged directly, because the codebase moved
underneath them. That does not make the work any less theirs.

This file is the fuller record. GitHub's contributor sidebar is built from
commit data, so anyone who found a bug without submitting code will never
appear there no matter how much they helped. They are listed here instead.

## Code contributions

People who opened pull requests.

- John McCardle - The Linux and Go side of this project. Linux compatibility
  groundwork, the Wine detection path, and the roadmap that got GobboNet off
  Windows-only. PRs #2 and #30. GobboNet would not run on Linux without him.
- neoliminal - Security review and hardening: rate limiting, GGUF metadata sanitization
  before it reaches generated command files, pinned SHA-256 checksums for the
  engine and embedding model, run-flag stripping on transferred state, and a
  sturdier escapeHtml fallback. PRs #3, #4, #5, #6, #7, and #8.
- Dawid Korach - Windows port handling, service-health checks, and the
  investigation and fixes for orphaned processes. Issue #14 and PR #15.
- James Sesler (@TheAmericanMaker) - Excluded generation spools from version
  control and corrected the privacy documentation. PR #16.
- Sam Henry (@sam-henry-dev) - Compatibility with newer llama.cpp sampler and
  logging behavior, and embedded Jinja template handling for Cydonia and
  Mistral Small models. PRs #28, #32, #34, and #40.
- ken00H - Safer model recommendations and GPU memory headroom, particularly
  for gpt-oss on 12 GB cards. PR #39.
- wizzense - LAN bind fallback, so local chat stays available when a
  network-facing bind is denied. PR #10.

## Security

- Solveig - Elodine's primary security consultant for close to five years.
  Not a GitHub user, and so absent from every automated credit list this
  project generates, which is exactly why the name belongs here. The security
  posture of this project owes a great deal to that ongoing counsel.

## Reports, findings, and testing

People who identified problems, traced causes, shared working fixes, or
clarified what the software actually needed to do. Several of these reports
saved considerably more time than the patch that followed them.

- @AdamBv1 - Identified the llama.cpp logging and DRY sampler compatibility
  changes. Issue #33.
- @gobbo-guy-1234 - Found and shared the working Cydonia Jinja/template
  correction. Issue #20.
- @norflic and @aexiel - Character identity and avatar behavior across
  conversations. Issue #19.
- @nephitejnf - Missing remote model lists on Linux. Issue #47.
- @KMaheshBhat - Connecting GobboNet to an independently managed llama.cpp
  server. Issue #48.
- @joeypent69 - Ollama integration feedback and clarification of
  model-selection requirements. Issue #27.
- @BadLuckCharm - Unsafe model recommendations on 12 GB GPUs. Issue #23.
- @SharkBeard - Reported the DRY sampler HTTP 400 failure. Issue #38.
- @FlashyUnphased - Reported the Linux startup failure and misleading
  launch.bat guidance. Issue #43.
- @Alunatopia - Reported the Windows "drive specified" startup messages.
  Issue #36.

Thanks also to the GobboNet Discord community, whose testing and reports
shaped fixes across the 1.5 and 1.6 releases.

## How credit works here

Pull requests are frequently reimplemented rather than merged. When that
happens the original author is recorded with a Co-authored-by trailer on the
commit that lands the work, so the contribution stays attached to them in the
repository history.

If you contributed and are not listed, or are listed in a way you would like
changed, open an issue and it will be corrected.
