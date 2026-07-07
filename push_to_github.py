import ctypes, ctypes.wintypes, requests, base64, os, sys
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

CRED_TYPE_GENERIC = 1

class CREDENTIAL_ATTRIBUTE(ctypes.Structure):
    _fields_ = [('Keyword', ctypes.c_wchar_p), ('Flags', ctypes.wintypes.DWORD),
                ('ValueSize', ctypes.wintypes.DWORD), ('Value', ctypes.c_char_p)]

class CREDENTIAL(ctypes.Structure):
    _fields_ = [('Flags', ctypes.wintypes.DWORD), ('Type', ctypes.wintypes.DWORD),
                ('TargetName', ctypes.c_wchar_p), ('Comment', ctypes.c_wchar_p),
                ('LastWritten', ctypes.wintypes.FILETIME), ('CredentialBlobSize', ctypes.wintypes.DWORD),
                ('CredentialBlob', ctypes.c_char_p), ('Persist', ctypes.wintypes.DWORD),
                ('AttributeCount', ctypes.wintypes.DWORD), ('Attributes', ctypes.POINTER(CREDENTIAL_ATTRIBUTE)),
                ('TargetAlias', ctypes.c_wchar_p), ('UserName', ctypes.c_wchar_p)]

def get_token():
    advapi32 = ctypes.windll.advapi32
    target = 'GitHub - https://api.github.com/RemoteSensingInnovators'
    p_cred = ctypes.POINTER(CREDENTIAL)()
    ok = advapi32.CredReadW(target, CRED_TYPE_GENERIC, 0, ctypes.byref(p_cred))
    if ok:
        cred = p_cred.contents
        blob = ctypes.string_at(cred.CredentialBlob, cred.CredentialBlobSize)
        return blob.decode('utf-8').rstrip('\x00')
    return None

TOKEN = get_token()
if not TOKEN:
    sys.exit("Token topilmadi!")

REPO   = "RemoteSensingInnovators/dashboard_gidrometrologiya"
API    = "https://api.github.com"
HEADERS = {
    "Authorization": f"token {TOKEN}",
    "Accept": "application/vnd.github+json",
}

# Branch aniqlash
for branch in ("main", "master"):
    r = requests.get(f"{API}/repos/{REPO}/branches/{branch}", headers=HEADERS, verify=False)
    if r.status_code == 200:
        BRANCH = branch
        break
else:
    sys.exit("Branch topilmadi!")

sys.stdout.buffer.write(f"Repo: {REPO}  Branch: {BRANCH}\n".encode('utf-8'))

FILES = [
    "index.html",
    "login.html",
    "dashboard.js",
    "style.css",
    "convert_kmz.py",
    "data/stations.geojson",
]

def get_sha(path):
    r = requests.get(f"{API}/repos/{REPO}/contents/{path}?ref={BRANCH}", headers=HEADERS, verify=False)
    if r.status_code == 200:
        return r.json().get("sha")
    return None

def push_file(path):
    with open(path, "rb") as f:
        content = base64.b64encode(f.read()).decode()
    sha = get_sha(path)
    payload = {"message": f"update: {path}", "content": content, "branch": BRANCH}
    if sha:
        payload["sha"] = sha
    r = requests.put(f"{API}/repos/{REPO}/contents/{path}", json=payload, headers=HEADERS, verify=False)
    status = "OK" if r.status_code in (200, 201) else f"XATO {r.status_code}"
    action = "yangilandi" if sha else "yaratildi"
    sys.stdout.buffer.write(f"  {status}  {path} ({action})\n".encode('utf-8'))

for f in FILES:
    if os.path.exists(f):
        push_file(f)
    else:
        sys.stdout.buffer.write(f"  O'TKAZILDI  {f}\n".encode('utf-8'))

sys.stdout.buffer.write(b"\nBarcha fayllar yuklandi!\n")
