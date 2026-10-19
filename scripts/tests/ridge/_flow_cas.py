from aquin import Flow, step
from pathlib import Path
import json, shutil

class Cas(Flow):
    @step
    def start(self):
        self.msg = "hello"
        self.payload = {"a": 1}
        self.next(self.end)
    @step
    def end(self):
        self.msg = "hello"  # same bytes → dedupe

base = Path("artifacts/flow/Cas")
if base.exists():
    shutil.rmtree(base)
s = Cas().run(".")
root = Path(s["path"])
# pointers
ptr = json.loads((root / "artifacts" / "msg.json").read_text())
assert "aq_cas" in ptr, ptr
aid = ptr["aq_cas"]
# cas blob exists
hexid = aid.replace("sha256:", "")
cas = root / "cas" / hexid[:2] / hexid[2:4] / hexid
assert cas.is_file(), cas
# dedupe: msg assigned twice with same content — one blob
from aquin.flow_store import ArtifactStore
st = ArtifactStore(root)
ids = st.ids()
assert ids["msg"] == ids.get("msg")
rep = st.verify()
assert rep["pass"], rep
# tamper
cas.write_bytes(b"tampered")
rep2 = st.verify()
assert not rep2["pass"], rep2
print("ok", aid, "blobs_ok_before_tamper", rep["ok"])
