# Third-party notices (sudo-agent)

## Architecture reference (no code reused)

The session/stream/registry architecture of this package was DESIGNED after
reading the architecture of the OpenCode project as a reference:

- Project: OpenCode (https://github.com/anomalyco/opencode, formerly sst/opencode)
- License: MIT License, Copyright (c) 2025 opencode
- Reference read: public sources on the `dev` branch (agent registry design,
  session and event concepts). No OpenCode source file was copied, in whole or
  in part, into this package: 100% of the code here is original.

MIT License text of the referenced project:

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

## Runtime dependencies

None. This package uses only the Node.js standard library (`http`, `https`,
`fs`, `os`, `path`, `crypto`, `url`). There is no third-party runtime code to
attribute.
