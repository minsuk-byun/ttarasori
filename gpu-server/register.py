"""터널 주소를 따라소리(Vercel)에 등록. 사용법: python3 register.py <https 터널 주소>"""
import base64
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.request

url = sys.argv[1].rstrip("/")
secret = os.environ.get("SERVICE_SECRET", "")
endpoint = os.environ.get("REGISTER_URL", "https://ttarasori.vercel.app/api/gpu/register")
if not secret:
    print("SERVICE_SECRET 이 없어 등록을 건너뛰어요.")
    sys.exit(0)

ts = int(time.time())
# 서버가 처음 켜진 시각: 더 늦게 켜진(새) 서버의 주소만 받아들이게 하는 데 써요
started_file = "/root/server-started-at"
try:
    started = int(open(started_file).read().strip())
except Exception:  # noqa: BLE001
    started = ts
    try:
        open(started_file, "w").write(str(started))
    except Exception:  # noqa: BLE001
        pass
sig = base64.urlsafe_b64encode(
    hmac.new(secret.encode(), f"{url}|{ts}|{started}".encode(), hashlib.sha256).digest()
).decode().rstrip("=")
req = urllib.request.Request(
    endpoint,
    data=json.dumps({"url": url, "ts": ts, "started": started, "sig": sig}).encode(),
    headers={"Content-Type": "application/json", "User-Agent": "ttarasori-gpu"},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=20) as r:
        print("등록 완료:", r.read().decode()[:200])
except urllib.error.HTTPError as e:
    print("등록 실패:", e.code, e.read().decode()[:200])
    sys.exit(1)
except Exception as e:  # noqa: BLE001
    print("등록 실패:", e)
    sys.exit(1)
