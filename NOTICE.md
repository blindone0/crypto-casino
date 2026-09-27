# Notice and attribution

This project is licensed under the **GNU Affero General Public License v3.0**.
The full text is in [LICENSE](LICENSE).

## What that means in practice

AGPL-3.0 was chosen over MIT or plain GPL deliberately, for two reasons.

**Derivative work must stay open.** Anyone who modifies this code and distributes it has
to publish their modified source under the same licence. A permissive licence like MIT
would let someone take this, improve it, and close it.

**Running it as a website counts as distributing it.** This is the part plain GPL gets
wrong for web software. Under GPL, if you modify a program and run it on your own server
without ever shipping the binary, you owe nobody your changes. That loophole covers
almost every online casino. AGPL section 13 closes it: if you run a modified version and
let other people use it over a network, you must offer those users the corresponding
source. For a project whose whole point is that players can verify what the house is
doing, that is the licence that matches the intent.

**Attribution must be preserved.** The copyright notices, this file, and the licence text
must travel with the code and with any derivative work.

## If you build on this

You are free to run it, modify it, and operate it commercially. In return:

1. Keep the AGPL-3.0 licence on your version.
2. Keep the copyright and attribution notices intact, and credit this project as the
   origin of the work you started from.
3. Publish your modified source, including to the players using your site. The usual way
   is a link in the site footer to your public repository.
4. State clearly what you changed.

## Third-party material

At the time of writing this project has **no third-party runtime dependencies at all**.
It runs on the Node standard library alone (`node:http`, `node:sqlite`, `node:crypto`),
and every asset (styles, SVG symbol artwork, card faces) is original work in this
repository. Nothing is pulled from a CDN, and the Content-Security-Policy forbids it.

The only external file is `LICENSE` itself, the verbatim GNU AGPL-3.0 text published by
the Free Software Foundation.

If you add a dependency or borrowed asset, record it here with its own licence, and check
that it is compatible with AGPL-3.0 before you ship it. Free art and audio packs
frequently carry a clause forbidding use in gambling products; read the terms rather than
assuming, because "free" and "usable in a casino" are not the same thing.

## Provably fair, and why the licence reinforces it

The fairness claims in this codebase are only meaningful if the code running on the server
is the code you can read. AGPL is what gives a player standing to ask for it.
