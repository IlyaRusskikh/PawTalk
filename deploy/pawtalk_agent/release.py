"""Bounded GitHub discovery and component-specific Ed25519 trust verification."""
import base64
import json
import re
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path

REPO = "IlyaRusskikh/PawTalk"
IMAGE = "ghcr.io/ilyarusskikh/pawtalk-server"
VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?\Z")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")


def semver(value):
    m = VERSION.fullmatch(value) if isinstance(value, str) else None
    if not m:
        raise ValueError("Invalid SemVer")
    pre = m[4]
    if pre and any(v.isdigit() and len(v) > 1 and v.startswith("0") for v in pre.split(".")):
        raise ValueError("Invalid prerelease")
    return (*map(int, m.groups()[:3]), 1 if pre is None else 0,
            tuple((0, int(v)) if v.isdigit() else (1, v) for v in (pre.split(".") if pre else [])))


def no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON field")
        result[key] = value
    return result


def loads(raw):
    return json.loads(raw, object_pairs_hook=no_duplicates)


def allowed_url(url, api=False):
    if not isinstance(url,str):
        raise ValueError('Invalid release URL')
    u = urllib.parse.urlsplit(url)
    if u.scheme != "https" or u.username or u.password or u.port or u.fragment:
        raise ValueError("Unsafe release URL")
    if api:
        prefix = '/repos/'+REPO.lower()+'/releases'
        if u.netloc != "api.github.com" or not (u.path.lower() == prefix or u.path.lower().startswith(prefix+'/')):
            raise ValueError("Unexpected metadata origin")
    elif u.netloc == "github.com":
        parts = u.path.split('/')
        if len(parts) < 7 or '/'.join(parts[1:3]).lower() != REPO.lower() or parts[3:5] != ['releases','download'] or u.query:
            raise ValueError("Unexpected asset origin")
    elif u.netloc != "release-assets.githubusercontent.com":
        raise ValueError("Unexpected download origin")


class Redirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        allowed_url(newurl,api=urllib.parse.urlsplit(newurl).hostname == 'api.github.com')
        return super().redirect_request(request, fp, code, msg, headers, newurl)


def fetch(url, limit=1024 * 1024, api=False):
    allowed_url(url, api)
    request = urllib.request.Request(url, headers={"User-Agent": "PawTalk-host", "Accept": "application/vnd.github+json"})
    with urllib.request.build_opener(Redirect()).open(request, timeout=30) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError("Release response too large")
    return data


def select(releases, component, channel):
    if component not in ("server", "deploy") or channel not in ("stable", "preview"):
        raise ValueError("Invalid release selector")
    result = []
    for release in releases:
        if not isinstance(release,dict):
            raise ValueError('Invalid GitHub release entry')
        tag = release.get("tag_name", "")
        prefix = component + "-v"
        if release.get("draft") or not isinstance(tag, str) or not tag.startswith(prefix):
            continue
        try:
            version = tag[len(prefix):]
            order = semver(version)
        except ValueError:
            continue
        if channel == "stable" and (release.get("prerelease") or order[3] == 0):
            continue
        result.append((order, release, version))
    return sorted(result, key=lambda entry: entry[0], reverse=True)


def verify(raw, component, keys, now=None):
    if len(raw) > 16384 or component not in ("server", "deploy"):
        raise ValueError("Invalid manifest size/type")
    envelope = loads(raw)
    if not isinstance(envelope,dict) or not all(isinstance(envelope.get(k),str) for k in ['keyId','payload','signature']):
        raise ValueError('Invalid signature envelope')
    if not isinstance(keys,dict) or not isinstance(keys.get(component),dict):
        raise ValueError('Invalid component trust roots')
    key = keys[component].get(envelope.get("keyId"))
    if not key:
        raise ValueError("Untrusted signing key")
    payload = base64.b64decode(envelope["payload"], validate=True)
    signature = base64.b64decode(envelope["signature"], validate=True)
    if len(signature) != 64:
        raise ValueError("Invalid Ed25519 signature")
    with tempfile.TemporaryDirectory(prefix="pawtalk-verify-") as directory:
        p = Path(directory)
        (p / "public.pem").write_text(key, encoding="utf-8")
        (p / "payload").write_bytes(payload)
        (p / "signature").write_bytes(signature)
        public = subprocess.run(['openssl','pkey','-pubin','-in',str(p/'public.pem'),'-pubout','-outform','DER'],capture_output=True,timeout=10)
        if public.returncode or len(public.stdout) != 44 or not public.stdout.startswith(bytes.fromhex('302a300506032b6570032100')):
            raise ValueError('Expected an Ed25519 trust root')
        checked = subprocess.run(["openssl", "pkeyutl", "-verify", "-pubin", "-inkey", str(p / "public.pem"), "-rawin",
                                  "-in", str(p / "payload"), "-sigfile", str(p / "signature")], capture_output=True, timeout=10)
        if checked.returncode:
            raise ValueError("Manifest signature failed")
    m = loads(payload)
    if not isinstance(m,dict):
        raise ValueError('Invalid manifest object')
    now = int(time.time()) if now is None else now
    if type(m.get('schema')) is not int or m.get("schema") != 1 or m.get("component") != component or m.get("repository") != REPO:
        raise ValueError("Manifest type/repository mismatch")
    semver(m.get("version"))
    if m.get("channel") not in ("stable", "preview") or ("-" in m["version"] and m["channel"] != "preview"):
        raise ValueError("Invalid signed channel")
    if any(type(m.get(k)) is not int for k in ("publishedAt", "expiresAt")) or not m["publishedAt"] <= now + 300 or not now < m["expiresAt"] <= m["publishedAt"] + 366 * 86400:
        raise ValueError("Expired/invalid manifest")
    if any(type(m.get(k)) is not int or m[k] != 1 for k in ['apiProtocol','dataSchema']):
        raise ValueError("Unsupported protocol/data schema")
    if component == "server":
        if m.get("image") != IMAGE or not isinstance(m.get('digest'),str) or not DIGEST.fullmatch(m['digest']):
            raise ValueError("Invalid server image/digest")
    else:
        if m.get("bundle") != "PawTalk.Deploy." + m["version"] + ".tar.gz" or not isinstance(m.get('sha256'),str) or not re.fullmatch(r"[a-f0-9]{64}", m['sha256']) or type(m.get("size")) is not int or not 0 < m["size"] <= 16 * 1024 * 1024:
            raise ValueError("Invalid deploy bundle")
        if any(type(m.get(k)) is not int or m[k] != 1 for k in ['launcherProtocol','configSchema']):
            raise ValueError("Unsupported launcher/config contract")
    m['_signed'] = raw.decode('utf-8') if isinstance(raw,bytes) else raw
    return m


def discover(component, channel, keys, get=fetch):
    releases = []
    for page in range(1, 101):
        batch = loads(get(f"https://api.github.com/repos/{REPO}/releases?per_page=100&page={page}", 4 * 1024 * 1024, api=True))
        if not isinstance(batch, list):
            raise ValueError("Invalid GitHub releases")
        releases.extend(batch)
        if len(batch) < 100:
            break
    else:
        raise ValueError("Release pagination limit exceeded; cannot determine latest")
    candidates = select(releases, component, channel)
    if not candidates:
        return None
    _, release, version = candidates[0]
    name = component + "-manifest.json"
    expected = f"https://github.com/{REPO}/releases/download/{component}-v{version}/{name}"
    def matches(asset):
        if not isinstance(asset,dict) or asset.get('name') != name or asset.get('state') != 'uploaded':
            return False
        url = asset.get('browser_download_url','')
        try:
            allowed_url(url)
            actual = urllib.parse.urlsplit(url)
            return actual.hostname == 'github.com' and actual.path.split('/')[3:] == urllib.parse.urlsplit(expected).path.split('/')[3:]
        except ValueError:
            return False
    assets = [a for a in release.get("assets", []) if matches(a)]
    if len(assets) != 1:
        raise ValueError("Missing/ambiguous signed manifest asset")
    raw = get(assets[0]['browser_download_url'], 16384)
    m = verify(raw, component, keys)
    if m["version"] != version or (m["channel"] == "preview") != bool(release.get("prerelease")) or (channel == "stable" and m["channel"] != "stable"):
        raise ValueError("Release/manifest binding mismatch")
    return m


def verify_historical(raw,component,keys):
    envelope = loads(raw)
    saved = loads(base64.b64decode(envelope['payload'],validate=True))
    return verify(raw,component,keys,now=saved['publishedAt'])


def verify_snapshot(meta,keys):
    """Authenticate the saved executable reference, allowing an old backup's age.

    Freshness applies to discovery, not an explicitly confirmed historical restore.
    The original publication/expiry interval must still have been valid.
    """
    state = meta['state']
    m = verify_historical(state['serverManifest'],'server',keys)
    if state['version'] != m['version'] or state['image'] != m['image']+'@'+m['digest'] or state['dataSchema'] != m['dataSchema']:
        raise ValueError('Backup image/version does not match the signed Server receipt')
    return m
