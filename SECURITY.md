# Why not malware, if malware-shaped?

```
guest@goblincorps:~$ cat /var/quarantine/verdict.txt
Trojan:Win32/Wacatac.B!ml — quarantined
```

*A field note on why a private, offline chat app keeps getting shot on sight.*
Not a bug report. Not an apology. Not a request for reinstatement.

---

## // doc.001 — the verdict

Windows Defender quarantined GobboNet. GobboNet is a one-click, fully local, fully private front end for running language models on your own computer. No account. No API key. No telemetry. It phones home to nobody, because there is no home to phone. It is, by any behavioral definition, one of the least dangerous things you can install on a Windows machine.

Defender disagreed. The label it reached for was `Trojan:Win32/Wacatac.B!ml`.

Read the suffix. `.B!ml` means the verdict came from a machine-learning model — a *shape* classifier. Not a signature. Not a hash of known-bad. Not a behavior it watched happen and recognized. A resemblance score. The engine looked at the code, compared its silhouette to a few million things labeled "malware," found the silhouette close enough, and quarantined it. Nobody at Microsoft looked. Nothing ran. A statistical model decided the shape was suspicious, and the shape was the whole trial.

So here is the question, and it is not rhetorical. If a piece of software is shaped like malware — if it genuinely, structurally resembles the thing — then why *not* treat it as malware? What exactly is the shape missing?

If you are simply looking for a workaround, here it is:
```
Windows Security > Virus & threat protection > Manage settings > Exclusions > Add an exclusion > Folder > then pick your GobboNet directory > if the download specifically is giving you trouble do these steps for your download folder
```

Still concerned but don't know code well? We recommend tossing the github link into a SOTA model for review. There is nothing to hide here!

---

## // doc.002 — yes. it is malware-shaped.

The temptation, when a scanner flags your clean code, is to cry false positive and post the VirusTotal link. We are not going to do that, because it would be dishonest, and because it is the boring version of this argument.

GobboNet is malware-shaped. Not "technically, if you squint." Actually. Here is the résumé, and every line of it is real:

- **It downloads an executable from the internet and runs it.** `launch.bat` builds a `Net.WebClient`, forces TLS 1.2, and calls `DownloadFile` under `-ExecutionPolicy Bypass` to pull down the llama.cpp release. That is the textbook first act of a dropper.
- **It binds a listener and serves traffic.** `fileserver.ps1` stands up a `System.Net.HttpListener` and serves content over the network. That is the resident half of a remote-access tool.
- **It opens holes in your firewall while elevated.** `setup-lan.bat` demands Administrator, then runs `netsh advfirewall firewall add rule ... dir=in action=allow` and reserves an all-interfaces URL namespace with `netsh http add urlacl url=http://+:PORT/ sddl=D:(A;;GX;;;WD)`. That is backdoor provisioning.
- **It fingerprints your hardware.** `hardware-probe.ps1` enumerates `Win32_VideoController`, dumps `dxdiag /x`, and reads GPU and CPU identifiers straight out of the registry. That is host reconnaissance.
- **It reaches into a `SecureString` and marshals your password back out to plaintext.** `launch.bat` calls `Marshal::SecureStringToBSTR` and `PtrToStringBSTR`. That is the exact API sequence a credential stealer uses.
- **It compiles native interop on the fly.** `launch.bat` runs `Add-Type` with `[DllImport("kernel32.dll")]` and `[DllImport("user32.dll")]` to get `GetConsoleWindow` and `ShowWindow`. Inline P/Invoke into `kernel32` is how in-memory loaders declare their tools.
- **It POSTs an authenticated body to an outside host.** `fileserver.ps1` forwards a request — Authorization header and all — to an external API over TLS. That is a beacon shape.
- **It enumerates running processes and force-kills them by command line.** `launch.bat` pipes `Get-CimInstance Win32_Process` into `Stop-Process -Force`. That is what malware does to the thing trying to stop it.
- **It generates cryptographic key material and hashes secrets.** `fileserver.ps1` pulls bytes from a CSPRNG and runs `SHA256` over a salted password. To a classifier, that reads like the opening move of ransomware.

Nine capabilities. Download-and-execute, listener, firewall modification, hardware recon, credential handling, native interop, outbound beacon, process termination, crypto. If you handed that capability list to a malware analyst with the names stripped off, they would not blink. They would start writing the report.

The classifier is not hallucinating. The shape is really there but because it makes things easier on new users, less confusing, and allocates logs to specified places for easy access.

---

## // doc.003 — detection accounting

For the record, here is the shape we present, weighted roughly the way an ML engine weights it. The complete scan — every file, every line — ships in the repo alongside this document.

| The construct | Where it lives | The benign job it does | The shape it shares |
|---|---|---|---|
| `Add-Type` + `DllImport(kernel32/user32)` | `launch.bat` | Minimize the launcher's own console window | In-memory loader declaring native imports |
| `Marshal::SecureStringToBSTR` → plaintext | `launch.bat` | Compare a typed password to the local access secret | Credential dumper lifting secrets from memory |
| `Net.WebClient.DownloadFile` + `-ExecutionPolicy Bypass` + TLS 1.2 | `launch.bat` | Fetch the llama.cpp release | Stage-two dropper |
| `HttpListener` + `netsh advfirewall add rule` + `urlacl http://+:` (elevated) | `fileserver.ps1`, `setup-lan.bat` | Serve the UI to your own phone, subnet-scoped, behind your password | Backdoor install and listener |
| `Invoke-WebRequest -Method POST`, forwards `Authorization`, to an outside host | `fileserver.ps1` | Proxy a web search so the browser skips a CORS hop | C2 beacon |
| `Get-CimInstance Win32_Process` → `Stop-Process -Force` | `launch.bat` | Kill the right model server on shutdown | Terminating the AV that's watching |
| `Win32_VideoController` + `dxdiag /x` + registry GPU/CPU reads | `hardware-probe.ps1` | Measure your VRAM to recommend a model that fits | Host fingerprinting / sandbox detection |
| `SHA256` + `RandomNumberGenerator` | `fileserver.ps1` | Log you in and mint a session token | Ransomware key setup |

Now the column the classifier never fills in.

---

## // doc.004 — the three things the shape can't carry

A silhouette is a projection. It throws away everything except the outline. And the three things it throws away are the only three things that separate GobboNet from the malware it resembles:

**Consent.** GobboNet does everything it does because you double-clicked it to. It opens the firewall in a script named `setup-lan.bat` that refuses to run without Administrator and tells you, in plain English, that it is about to open the firewall. Malware does not ask. That is arguably the *definition* of malware — software that acts on the system's authority against the user's interest. Consent is not a property of the opcode. `netsh advfirewall add rule` is the same instruction whether you asked for it or it asked for itself. The shape is identical. The consent is the entire difference, and the shape cannot hold it.

**Destination.** GobboNet's dropper downloads from a named, readable release URL and runs a signed, well-known inference engine. Its beacon POSTs to a search API you configured, forwarding *your* credential to *your* chosen provider. Its listener binds to your LAN, scoped to your subnet, reachable only by devices you own, behind a password you set. Change the destinations and you have malware — same code, different addresses. The classifier sees "downloads and executes," "POSTs authenticated traffic outward," "binds a port." It does not, and structurally cannot, weigh *where*. Where is the whole story. The shape drops it.

**Disclosure.** This is the one that should sting. GobboNet is not just benign; it is *legible*. Open any of these files and the code explains itself to you — what it does, why it does it, and what it deliberately does not do. The credential marshaling zero-frees the buffer afterward, because someone cared. The firewall rule is subnet-scoped and the comment says so. The hidden-window spawn was *removed*, on purpose, and the comment explaining why is still sitting in the launcher. Malware discloses nothing. Malware is the opposite of legible by design, because legibility gets it caught. GobboNet chose to be readable. The classifier cannot read intent off a silhouette, so the one property that most reliably distinguishes a tool from a weapon — *does it explain itself?* — is exactly the property it discards.

Consent, destination, disclosure. Strip those three and malware and GobboNet are the same program. The classifier strips those three *by construction.* It was built to see shape and only shape. So it convicts, and it convicts precisely because it is doing the one thing it knows how to do.

This is a modeling problem, not a threat.

---

## // doc.005 — why a private AI launcher has a RAT's résumé

It is worth sitting with *why* the shapes line up so well, because it is not an accident and it is not sloppiness.

The job GobboNet does is: run a large AI model on your own machine, and let you reach it from your phone. Decompose that job honestly and here is what falls out. You do not have the multi-gigabyte inference binary, so something has to **fetch an executable from the internet**. The model has to be served somewhere, so something has to **stand up a local server**. Not every model fits every GPU, so something has to **inventory your hardware**. And "reach it from your phone" means **opening a path on your own network**.

Fetch a binary. Run a server. Fingerprint the host. Open the network. That is the job description for a private inference launcher. It is also, word for word, the job description for a remote-access tool. The overlap is not a coincidence and it is not a smell. It is what happens when two very different intentions require the same primitives. A kitchen knife and a murder weapon have identical metallurgy. The difference has never been in the steel.

Which is the uncomfortable structural truth underneath the whole quarantine: **there is no benign capability set for this category of software that does not also describe a RAT.** You cannot write a local-model launcher that fetches nothing, serves nothing, and touches no network, because then it is not a launcher, it is a text file. The capabilities *are* the product. A classifier trained on capability-shape will flag every honest member of this category, forever, because the honest members and the malicious ones are built from the same parts. The only variable is the three things the classifier cannot see.

---

## // doc.006 — the transparency tax

Here is where it stops being merely wrong and starts being backwards.

GobboNet used to have a genuinely damning construct. The web search feature was once a separate PowerShell process, started with `-WindowStyle Hidden` and `-EncodedCommand`, carrying a **4,656-character base64 blob**, opening its own listener and relaying authenticated traffic to an external host. Committed to the repo: *"indistinguishable in shape from a command-and-control relay."* So we removed it. It is now a plain function in `fileserver.ps1` that does the same thing in readable code. Same destination, same request, same header — one fewer encoded process, and the single strongest malware signal in the project, gone.

Here is what we wrote next to that change:

> *A `.ps1` on disk gets AMSI-scanned in plaintext and reads as what it is.*

We kept the code as **plaintext PowerShell on disk, specifically so the antivirus could read it.** We chose the most transparent, most auditable, most inspectable form available — the form that hides nothing from the scanner — as a matter of principle.

And the scanner flagged them anyway.

Now watch what the incentive structure actually rewards. Real malware authors know exactly what trips `.B!ml`. They know encoded PowerShell is weighted heavily. So they encode nothing the scanner reads and everything it doesn't — they pack, they obfuscate, they sign with stolen certs, they sleep past the sandbox, they stage the payload in three innocuous-looking pieces. They make the shape go away, because making the shape go away is their entire profession. The malware evades. Reliably. That is the baseline assumption of the entire industry — signature and shape detection is understood to be the floor, not the ceiling, precisely because the adversary adapts.

The independent developer who wrote a clear comment explaining their firewall rule does not do any of that. They have nothing to hide, so they hide nothing, so the shape is fully exposed, and we get caught. The obfuscator walks. The honest one gets quarantined. The heuristic is a tax, and the thing it taxes is transparency. It falls hardest on exactly the property — legibility — that makes software auditable, forkable, trustworthy, and *safe*. It rewards the one behavior — hiding your shape — that is the actual reliable signature of malicious intent.

Follow that to its conclusion and it is genuinely perverse: the rational response to a shape classifier, *for a benign developer*, is to start obfuscating your benign code so it stops looking like the malware it isn't. To make your software less readable in order to make it less suspicious. To hide from the scanner the way the malware does, so the scanner stops confusing you for malware. A safety system that makes "become less auditable" the winning move has inverted its own purpose.

We are not going to do that. More on which below.

---

## // doc.007 — the performance of safety

Our creed has a line in it about [security theatre — the performance of safety over actual safety](https://goblincorps.com/manifest). This is that. It is the cleanest example of it we have ever shipped, which is why it is getting its own page.

A `.B!ml` detection is an *artifact*. It is a thing a security product can generate, count, display on a dashboard, and cite in a quarterly report. It looks like protection. It has the shape of protection. It does not make anyone safer, and you can prove that from both ends:

It does not stop the malware, because the malware it is shaped to catch changed its shape before shipping — that is assumed, that is the adversary's job, that is why shape detection is the floor. And it does not protect the user from GobboNet, because GobboNet was never going to hurt them. The detection catches the software that isn't dangerous and misses the software that is. What it reliably produces is not safety. It is a scary string, a quarantine, and a support burden dumped on a developer who gave her work away for free.

The safety is the justification. The detection is the product.

---

## // doc.008 — what actual safety reads

We are not against detection. We are against detection that reads shape and calls it behavior. So, in the tradition of saying what we'd support instead of only what we're against:

**Read behavior, not silhouette.** The three variables the classifier drops — consent, destination, disclosure — are not unknowable. They are *observable*. Did the user initiate this? Where is the traffic actually going? Is the connection scoped to the local subnet or dialing an IP in a country the user has never heard of? A system that watched what code *did* instead of what it *looked like* would clear GobboNet in one pass and catch the encoded relay we deleted. Behavior is harder to fake than shape. That is the point of watching it.

**Weigh provenance.** Is this from a public repository with a commit history a human can read? Is it signed? Does it have a reputation, a maintainer, a trail? "Unsigned script from nowhere" and "open-source project with a year of public development" are different risk profiles, and a scanner that treats them identically is discarding the cheapest, most reliable signal it has.

**Let the user see and decide.** Show the person what tripped the wire and why. "This program opens a firewall port and downloads an executable" is true, useful, and honest. `Trojan:Win32/Wacatac.B!ml`, delivered as a quarantine with no appeal, is a verdict dressed up as a fact. Adults running software on their own machines can be told the truth and trusted with it. That is not a radical position. It is the whole basis of informed consent, which is the thing malware violates and the thing a good scanner should be *protecting*.

**Make the honest path cheap.** Code signing that an individual developer can actually afford. A false-positive appeal that a human reads this decade. An analysis pipeline that rewards transparency instead of taxing it. The reason obfuscation wins right now is that being legible costs you a quarantine and being opaque costs you nothing. Flip that and watch the incentives sort themselves out.

None of this is exotic. It is what actual security researchers — the people who do this for a living, who we are not — have been saying for years. We just got flagged loudly enough to write it down.

---

## // doc.009 — "just buy a certificate"

The reasonable objection, at this point, is practical. *Fine* — you say — the model is broken, the incentives are backwards, point taken. But there is a known workaround. Buy an Authenticode code-signing certificate, sign the binaries, and the flag goes away. Everyone does it. Why plant a flag on a hill when you could pay the toll and ship?

Three reasons. It does not work. You would not even be paying Microsoft. And it is the exact thing this project exists to refuse.

**It does not reliably clear the flag.** A `.B!ml` verdict is a judgment about the *code* — its shape, its behavior, its resemblance. A signature is a statement about the *publisher* — who compiled it. Those are different axes, and bolting on the second does not move the first. This is not our theory; it is Microsoft's own support engineers, in writing: [a signature alone will not bypass behavioral detection](https://learn.microsoft.com/en-us/answers/questions/5635032/urgent-help-windows-defender-falsely-flags-our-dig). Defender does not trust a file because it is signed. Go read the developers who tried. One signed an *empty project* — a hello-world skeleton, nothing in it — with a paid EV certificate, and Defender flagged the skeleton as an `!ml` trojan anyway; the false-positive form got fed the same file [something like fifty times over two months](https://github.com/wailsapp/wails/issues/3308), and the answer, when there was one, was "it's a false positive, update your definitions." Another wrote an app that downloads files, unzips them, and opens a login socket — which is to say, roughly what GobboNet does — and drew `Wacatac!ml` on every rebuild, certificate or no certificate. The signature changes who signed the shape. It does not change the shape. The classifier reads the shape.

**And you are not paying Microsoft anyway.** This is the part that ought to be funny. A code-signing certificate is not sold by Microsoft. It is sold by a Certificate Authority — DigiCert, Sectigo, the usual toll-collectors — for [somewhere between a few hundred and a few thousand dollars a year](https://redcanary.com/blog/threat-detection/code-signing-certificates/), now mandatorily parked on a hardware token you also buy. Microsoft, who owns the scanner that flagged you, sells you nothing and promises you nothing. By DigiCert's *own* documentation, Microsoft [no longer guarantees SmartScreen reputation even for EV-signed files](https://knowledge.digicert.com/alerts/ev-signed-application-showing-microsoft-defender-smartscreen-warnings); reputation is a separate, Microsoft-controlled layer that accrues through download volume, install counts, and "publisher history" — none of which a new project has, all of which Microsoft alone adjudicates, on a timeline it declines to publish. So the shape of the deal is: pay Party A an annual fee, to maybe satisfy Party B, who owns the scanner, owes you nothing, guarantees nothing, and won't tell you when. That is not a fix. That is a subscription to a *maybe*.

**The signature isn't even a trust signal.** Here is the punchline. The certificate you are being told to buy — the one that supposedly proves legitimacy — is routinely worn by actual malware. Signed malware is not an edge case; the people who hunt it [report finding it routinely](https://redcanary.com/blog/threat-detection/code-signing-certificates/). The Blister loader shipped under a valid commercial cert. Researchers have catalogued dozens of compromised certificates signing live malware in the wild. Malware has been signed [by Microsoft's own hardware-compatibility program](https://cloud.google.com/blog/topics/threat-intelligence/hunting-attestation-signed-malware) — malicious drivers, carrying Microsoft's own signature, built to kill the endpoint protection watching them. Meanwhile the *free* option — signing it yourself — is treated as **worse** than nothing: to Defender, [a self-signed certificate is a hallmark of malware](https://www.bcs.org/articles-opinion-and-research/what-happens-when-microsoft-defender-flags-your-software/), ranked below an unsigned file. So the only signature that helps is the one you rent; it helps unreliably; and the guilty rent it too. You would be buying a lanyard that reads TRUSTED, from a shop that sells the same lanyard to anyone, to satisfy a bouncer who has been fooled by it before and knows it.

Now set that against what this project is. [NO CORPO MONEY. NO MASTERS.](https://goblincorps.com/manifest) GobboNet exists to demonstrate that you can run AI on your own machine without renting permission from a platform. Paying a certificate authority for the privilege of not being flagged — funding the precise toll-booth architecture the project stands against, for a maybe, for a credential the malware also carries — is not a pragmatic compromise. It is the entire thing we said we would not do, done quietly, for a green checkmark that might not even turn green.

To be exact, because it matters: we are not against signing. Signing a binary so a user can verify it was not tampered with in transit is a real and good use of the technology, and we have no quarrel with it. We are against signing sold as **protection money** — the annual fee you hand a third party so that a model at a first party stops crying wolf about your honest, readable code. Integrity signing is a security tool. Signing-to-avoid-detection is a moat wearing a lanyard.

And the provenance the signature is a paid proxy for? We already provide it. It is called a public repository. It has a commit history a human can read, a year of development done in the open, every file unpackaged, every change diffable, every comment left intact — including the ones where we narrate removing the one construct that deserved removing. That is provenance. That is the actual thing a certificate gestures at from behind a paywall. We give it away, to anyone, forever. It simply does not route through a billing department — which is the one form of provenance the system is built to charge for.

We could buy the receipt. We cannot buy our way out of a verdict that was never about who we are.

---

## // doc.010 — the refusal

Standard advice, when Defender flags you, comes in two flavors. The last section handled one: rent a signature to vouch for the shape. This one is the other: change the shape so it stops looking like itself. Sand off the triggers. Encode less, sure — but also split the download so it looks less like a download, rename the functions, break up the firewall call, wrap the P/Invoke so it reads differently. Make your shape stop looking like the shape. Appease the model. Two roads. Same toll: give something up so the flag goes away.

We decline. Both roads.

We already removed the one construct that was *genuinely* over the line — the encoded, hidden, listening relay — and we removed it for an honest reason: it was legitimately indistinguishable from a C2 channel, and reducing that ambiguity made the code more truthful about itself, not less. That is the correct reason to change code. "A statistical model finds this shape unnerving" is not.

Everything the scanner flags now is doing legible, necessary, disclosed work. The firewall rule opens the port your phone needs, scoped to your subnet, and says so. The download fetches the engine, from a URL you can read. The hardware probe reads your GPU so it can recommend a model that won't thrash your machine, and writes the result to a JSON file you can open. The credential marshaling checks the password you set and wipes the buffer after. Hiding any of that — obfuscating it, encoding it, breaking it into shapes the model doesn't recognize — would make GobboNet *less auditable* in order to satisfy a system that claims to be about safety. It would make the code harder for a human to read in order to make it easier for a machine to swallow. It would turn a transparent program opaque to dodge a tax on transparency.

That is the exact inversion this whole page is about, and we are not going to enact it on ourselves to get a green checkmark.

So the code stays readable. The comments stay in. The shape stays honest, which means it stays malware-shaped, because the job it does has a malware-shaped silhouette and there is no honest way around that. If a machine-learning model wants to keep flagging a plaintext, open-source, offline chat app because it has the outline of the thing instead of the substance of it, that is a statement about the model, not the app.

Read the code. It is all right there. That was always the point.

---

```
guest@goblincorps:~$ file ./gobbonet
./gobbonet: benign software, malware-shaped, fully disclosed, unrepentant
```

*The behavior is the evidence. The shape is just the shadow it casts.*

— **Elodine**, GoblinCorps
*We build free tools. We expose bad actors. Sometimes the bad actor is a classifier.*

---

<sub>GobboNet is free and open-source, entirely local, entirely private. The complete Wacatac trigger inventory referenced in §003 ships in the repository. All quoted source comments are from the `v1.6` tree and can be verified there. This document is commentary and is not affiliated with, endorsed by, or reviewed by Microsoft Corporation. `Wacatac`, `Defender`, and `Windows` are their marks, not ours. No shapes were sanded in the making of this software.</sub>

<sub>SPDX-License-Identifier: Unlicense</sub>
