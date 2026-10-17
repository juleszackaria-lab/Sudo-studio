# THIRD PARTY NOTICES - Sudo Studio AI extension

## 1. OpenCode - MIT License (attribution retained)

OpenCode v1.19.0 (https://github.com/sst/opencode) was integrated as a local
agent server up to MISSION P26 and REMOVED in P27 (binary, manifest, driver,
dependency closure: no longer shipped). The MIT attribution below is retained
in this file as required; it is the only OpenCode mention left in the product.

```
MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 2. VS Code Codicons (bundled UI icons, MISSION P4)

- Package: @vscode/codicons (css + font), files: sudo-ai-extension/media/codicon.css,
  sudo-ai-extension/media/codicon.ttf, full license: media/codicons-LICENSE.txt
- License: CC-BY-4.0 (c) Microsoft Corporation; attribution satisfied by this notice.

## 3. OSV advisory data (offline vulnerability base, MISSION P23)

The shipped file `src/data/advisories.json` is a compact subset built at
packaging time from the OSV bulk dumps (`generatedAt` extraction date is
embedded in the file; per-ecosystem record counts too). Upstream:
https://osv.dev - dumps at
https://storage.googleapis.com/osv-vulnerabilities/*/all.zip
(npm, PyPI, crates.io, Go, Maven, NuGet, Pub).

Kept per record: OSV id, CVE alias, package name, affected ranges, fixed
version, severity, short summary. Withdrawn records and MAL-* entries
(malware, not vulnerabilities) are excluded. Each upstream source keeps
its own data license; redistribution with attribution follows the OSV
ingestion terms (https://google.github.io/osv.dev/data/):

- GitHub Advisory Database (GHSA-*) - CC-BY-4.0,
  https://github.com/github/advisory-database
- PyPI Advisory Database (PYSEC-*) - CC-BY-4.0,
  https://github.com/pypa/advisory-database
- Go Vulnerability Database (GO-*) - CC-BY-4.0,
  https://github.com/golang/vulndb
- RustSec Advisory Database (RUSTSEC-*) - CC0-1.0,
  https://github.com/RustSec/advisory-db
- Global Security Database (GSD-*) - CC0-1.0,
  https://github.com/cloudsecurityalliance/gsd-database
- NVD enrichment (CVE ids, CVSS scores via OSV) - U.S. Government work,
  public domain, https://nvd.nist.gov ; CVE Program, https://www.cve.org
