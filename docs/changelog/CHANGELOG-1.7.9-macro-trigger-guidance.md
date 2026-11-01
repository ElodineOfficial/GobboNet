# Macro trigger guidance

The macro editor showed triggers with braces without explaining that the name field expects the name alone. The field and validation message now explain this with an example.

Testing: staged the web assets, ran the frontend and Go suites and the Python suites except Linux onboarding, and checked the editor and validation alert in Chrome. The optional PowerShell process-table checks were skipped because the available container wrapper does not forward their environment. Linux onboarding needs a built binary and engine. Not tested in a Windows console.
