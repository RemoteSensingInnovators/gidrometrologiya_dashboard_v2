import requests
import base64
import os
import sys

REPO    = "RemoteSensingInnovators/dashboard_gidrometrologiya"
BRANCH  = "main"
API     = "https://api.github.com"

TOKEN = input("GitHub Personal Access Token kiriting: ").strip()

HEADERS = {
    "Authorization": f"token {TOKEN}",
    "Accept": "application/vnd.github+json",
}

FILES = [
    "index.html",
    "login.html",
    "dashboard.js",
    "style.css",
    "convert_kmz.py",
    "data/stations.geojson",
]

def get_sha(path):
    url = f"{API}/repos/{REPO}/contents/{path}?ref={BRANCH}"
    r = requests.get(url, headers=HEADERS)
    if r.status_code == 200:
        return r.json().get("sha")
    return None

def push_file(path):
    with open(path, "rb") as f:
        content = base64.b64encode(f.read()).decode()

    sha = get_sha(path)
    payload = {
        "message": f"Update: {path}",
        "content": content,
        "branch": BRANCH,
    }
    if sha:
        payload["sha"] = sha

    url = f"{API}/repos/{REPO}/contents/{path}"
    r = requests.put(url, json=payload, headers=HEADERS)
    if r.status_code in (200, 201):
        action = "yangilandi" if sha else "qo'shildi"
        print(f"  OK  {path} — {action}")
    else:
        print(f"  XATO  {path} — {r.status_code}: {r.json().get('message','')}")

print(f"\nRepository: {REPO}\nBranch: {BRANCH}\n")

# Avval main branch mavjudligini tekshir, yo'q bo'lsa master sinab ko'r
r = requests.get(f"{API}/repos/{REPO}/branches/{BRANCH}", headers=HEADERS)
if r.status_code == 404:
    BRANCH = "master"
    print(f"'main' topilmadi, 'master' ishlatiladi.\n")

for f in FILES:
    if os.path.exists(f):
        push_file(f)
    else:
        print(f"  O'TKAZILDI  {f} — fayl topilmadi")

print("\nBarcha fayllar yuklandi!")
