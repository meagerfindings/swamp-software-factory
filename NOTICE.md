# Attribution and fork provenance

`@mgreten/software-factory` is Mat Greten's maintained fork of the upstream
`@swamp/software-factory` extension originally developed by System Initiative,
Inc. in the
[swamp extensions repository](https://github.com/swamp-club/swamp-extensions).

The initial fork was made exclusively from the `software-factory/` subtree at
upstream commit `7739f4357a6bc9503ab8ac953ae4b0826eb68603` (short form
`7739f4357`). The fork's Git history starts with a local import commit; this
notice preserves the upstream history boundary and source attribution.

The upstream root `COPYING` and `COPYING-EXCEPTION` files are preserved verbatim
in Git as provenance copies from that commit. Because Swamp Lab issue #1564
rejects extensionless `additionalFiles`, the registry archive carries
byte-identical copies named `COPYING.txt` and `COPYING-EXCEPTION.txt`. This
software is licensed under the GNU Affero General Public License, version 3 or
(at your option) any later version (`AGPL-3.0-or-later`), with the Swamp
Extension and Definition Exception as an additional permission. The upstream
`LICENSE.txt` notice is also preserved verbatim and retains the upstream
copyright notice:

> Copyright (C) 2026 System Initiative, Inc.

See [COPYING.txt](COPYING.txt) for the complete AGPL text and
[COPYING-EXCEPTION.txt](COPYING-EXCEPTION.txt) for the complete exception text.
The extensionless [COPYING](COPYING) and
[COPYING-EXCEPTION](COPYING-EXCEPTION) files remain at the repository root for
exact upstream provenance but are not included through `additionalFiles`.

The fork renames the publish identity, model type, report type, documentation,
examples, and bundled skill commands to `@mgreten/software-factory`. References
to `@swamp/software-factory` in this notice and the README identify the original
upstream project and are attribution, not the fork's runnable type.
