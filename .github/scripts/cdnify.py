#!/usr/bin/env python3
"""Deploy-time rewrite: serve heavy media from jsDelivr instead of reg.ru.
(Enduro version, 28.10.2026: media live in the site root, not in assets/;
.mov added; files over 20 MB stay on the hosting because jsDelivr refuses them.)

Usage: python3 .github/scripts/cdnify.py <site_root> <commit_sha> [owner/repo]

Each file is pinned to the LAST commit that changed it (git log -1 -- path), so
its CDN URL stays the same across deploys and browsers/jsDelivr keep it cached;
only changed files get a new URL. Needs full history (checkout fetch-depth: 0);
on a shallow clone, without git, or for uncommitted files it falls back to
<commit_sha> for everything (still correct, just less cache reuse).

For every *.html under <site_root> (outside assets/, .git, .github, node_modules)
relative references to media under assets/ (.mp4 .jpg .jpeg .png .webp) are
replaced by https://cdn.jsdelivr.net/gh/<owner/repo>@<sha>/assets/...
This covers src=, poster=, srcset=, data-*=, href=, inline url(...) and JS
string literals ('assets/..', '../assets/..'), resolved against the page folder.

Left untouched: absolute URLs (og:image, twitter:image, JSON-LD all point at
https://tinadigital.ru/...), data: URIs, fonts/css/js/svg, <meta> tags,
<script type="application/ld+json"> blocks, and any path whose file does not
exist in the checkout.

A tiny inline script is injected into <head>: if a CDN media element fails to
load (capture-phase 'error'), it retries the same file from this site once.
It also exposes window.cdnLocal(url) for media loaded from JS (WebGL textures,
Image() for canvas), which call it in their own error handlers.
"""
import os
import posixpath
import re
import subprocess
import sys
from urllib.parse import quote

MEDIA_EXT = ('mp4', 'mov', 'jpg', 'jpeg', 'png', 'webp')
JSDELIVR_MAX = 20 * 1024 * 1024
SKIP_DIRS = {'.git', '.github', '.claude', 'node_modules', '_tools', '_preview'}

# relative path to assets/ that is NOT part of an absolute URL: the char before
# must not be a word char, '/', '.', ':' or '-' (so https://site/assets/.. is skipped)
REF_RE = re.compile(
    r'(?<![\w/.:\-%])'
    r'((?:\./)?(?:\.\./)*[A-Za-z0-9_][A-Za-z0-9_.\-/]*?\.(?:' + '|'.join(MEDIA_EXT) + r'))'
    r'(?=[\s"\'()<>,\\?#&]|$)',
    re.IGNORECASE)
# blocks that must stay byte-identical
PROTECT_RE = re.compile(
    r'<meta\b[^>]*>'
    r'|<script\b[^>]*type=["\']application/ld\+json["\'][^>]*>.*?</script>'
    r'|<link\b[^>]*rel=["\'](?:canonical|alternate|icon|apple-touch-icon|manifest)["\'][^>]*>',
    re.IGNORECASE | re.DOTALL)
HEAD_RE = re.compile(r'<head\b[^>]*>', re.IGNORECASE)
CHARSET_RE = re.compile(r'<meta\s+charset=[^>]*>', re.IGNORECASE)

FALLBACK_JS = (
    '<script>(function(C,L){'
    'function f(u){var i;if(typeof u!="string"||u.indexOf(C)!==0)return null;'
    'i=u.indexOf("/",C.length);return i<0?null:L+u.slice(i+1)}'
    'window.cdnLocal=f;'
    'addEventListener("error",function(e){var t=e.target,n=t&&t.tagName,s,v;'
    'if(!n||t.__cdnfb||!/^(IMG|VIDEO|SOURCE|AUDIO)$/.test(n))return;'
    'v=n=="SOURCE"?t.parentNode:t;'
    's=f(t.getAttribute("src")||"");'
    'if(!s&&n=="IMG")s=f(t.currentSrc);'
    'if(!s)return;t.__cdnfb=1;'
    'if(t.srcset)t.srcset=t.srcset.split(",").map(function(x){var p=x.trim().split(/\\s+/),l=f(p[0]);if(l)p[0]=l;return p.join(" ")}).join(", ");'
    'if(v&&v.poster&&f(v.getAttribute("poster")))v.setAttribute("poster",f(v.getAttribute("poster")));'
    't.setAttribute("src",s);'
    'if(n!="IMG"&&v&&v.load){v.load();if(v.autoplay||v.hasAttribute("autoplay")){var p=v.play();p&&p.catch&&p.catch(function(){})}}'
    '},true)})(%s,%s)</script>'  # C = "https://cdn.jsdelivr.net/gh/owner/repo@", L = page's path to site root
)


class Pinner:
    """path under root -> commit sha whose tree has exactly this file content."""

    def __init__(self, root, head_sha):
        self.root, self.head, self.cache, self.enabled = root, head_sha, {}, False
        try:
            shallow = self.git('rev-parse', '--is-shallow-repository').strip()
            head = self.git('rev-parse', 'HEAD').strip()
            self.enabled = shallow == 'false' and head == head_sha
        except Exception:
            pass
        self.stats = {'own': 0, 'head': 0}

    def git(self, *args):
        return subprocess.run(('git', '-C', self.root) + args, capture_output=True,
                              text=True, check=True).stdout

    def last_commit(self, rel):
        """commit that last changed rel, if its tree holds exactly the working file."""
        work = self.git('hash-object', '--', rel).strip()
        c = self.git('log', '-1', '--format=%H', 'HEAD', '--', rel).strip()
        return c if c and self.blob(c, rel) == work else None

    def blob(self, commit, rel):
        try:
            return self.git('rev-parse', '%s:%s' % (commit, rel)).strip()
        except subprocess.CalledProcessError:
            return None

    def __call__(self, rel):
        if rel in self.cache:
            return self.cache[rel]
        sha = self.head
        if self.enabled:
            try:
                # index.html derives a cube video's poster at runtime
                # (x.mp4 -> x-poster.jpg), so both must live under one commit:
                # take the later of the two last-change commits and verify it.
                group = [rel]
                if rel.endswith('.mp4'):
                    poster = rel[:-4] + '-poster.jpg'
                    if os.path.isfile(os.path.join(self.root, poster)):
                        group.append(poster)
                commits = [self.last_commit(r) for r in group]
                if all(commits):
                    c = commits[0]
                    for other in commits[1:]:
                        if subprocess.run(('git', '-C', self.root, 'merge-base', '--is-ancestor', c, other),
                                          capture_output=True).returncode == 0:
                            c = other
                    works = [self.git('hash-object', '--', r).strip() for r in group]
                    if all(self.blob(c, r) == w for r, w in zip(group, works)):
                        sha = c
            except Exception:
                pass
        self.stats['own' if sha != self.head else 'head'] += 1
        self.cache[rel] = sha
        return sha


def rewrite(html, page_dir, root, cdn_base, pin=None):
    protected = []

    def stash(m):
        protected.append(m.group(0))
        return '\x00%d\x00' % (len(protected) - 1)

    body = PROTECT_RE.sub(stash, html)
    count = 0

    def repl(m):
        nonlocal count
        ref = m.group(1)
        resolved = posixpath.normpath(posixpath.join(page_dir, ref))
        full = os.path.join(root, resolved)
        if resolved.startswith('../') or not os.path.isfile(full):
            return ref
        if os.path.getsize(full) > JSDELIVR_MAX:
            return ref
        count += 1
        base = cdn_base
        if pin:
            base = cdn_base.rsplit('@', 1)[0] + '@' + pin(resolved) + '/'
        return base + quote(resolved)

    body = REF_RE.sub(repl, body)
    body = re.sub('\x00(\\d+)\x00', lambda m: protected[int(m.group(1))], body)

    if count:
        depth = page_dir.count('/') + 1 if page_dir else 0
        local_prefix = '../' * depth
        snippet = FALLBACK_JS % ('"%s@"' % cdn_base.rsplit('@', 1)[0], '"%s"' % local_prefix)
        cm = CHARSET_RE.search(body)
        hm = HEAD_RE.search(body)
        anchor = cm or hm
        if anchor:
            body = body[:anchor.end()] + snippet + body[anchor.end():]
        else:
            body = snippet + body
    return body, count


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    root = os.path.abspath(sys.argv[1])
    sha = sys.argv[2].strip()
    repo = sys.argv[3] if len(sys.argv) > 3 else 'Christina25031995/nordtrail-enduro'
    if not re.fullmatch(r'[0-9a-f]{7,40}', sha):
        sys.exit('bad sha: %r' % sha)
    cdn_base = 'https://cdn.jsdelivr.net/gh/%s@%s/' % (repo, sha)

    pin = Pinner(root, sha)
    total = 0
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = os.path.relpath(dirpath, root).replace(os.sep, '/')
        rel_dir = '' if rel_dir == '.' else rel_dir
        if rel_dir == '':
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        else:
            dirnames[:] = [d for d in dirnames if d not in ('.git', 'node_modules')]
        for fn in filenames:
            if not fn.lower().endswith('.html'):
                continue
            path = os.path.join(dirpath, fn)
            with open(path, encoding='utf-8') as fh:
                html = fh.read()
            new, n = rewrite(html, rel_dir, root, cdn_base, pin)
            if n:
                with open(path, 'w', encoding='utf-8') as fh:
                    fh.write(new)
            total += n
            print('%4d  %s' % (n, posixpath.join(rel_dir, fn)))
    print('cdnify: %d media references -> %s' % (total, cdn_base))
    print('cdnify: per-file pinning %s; files pinned to their own commit: %d, to this commit: %d'
          % ('on' if pin.enabled else 'OFF (shallow/no git)', pin.stats['own'], pin.stats['head']))


if __name__ == '__main__':
    main()
