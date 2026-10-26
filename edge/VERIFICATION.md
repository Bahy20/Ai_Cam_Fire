# Local evidence verification (development PC, not Pi deployment)

Commands run from `E:/coding/fire`, Windows/Python 3.11:

```sh
.venv/Scripts/python.exe -m unittest scripts.tests.test_edge_evidence -v
.venv/Scripts/python.exe -m unittest discover -s scripts/tests -p 'test_edge*.py' -v
.venv/Scripts/python.exe -m unittest discover -s scripts/tests -q
.venv/Scripts/python.exe edge/agent.py --help
```

The pre-retirement Python suite returned **81 tests, OK**. The post-retirement checkpoint was **39 tests, OK**. After the reviewed heartbeat/progress changes, the final active full Python suite returned **53 tests, OK** in 2.886 seconds; this is not a detector-accuracy result. New feature slices were
executed RED -> GREEN: missing recorder; missing cloud/tail API; budget not
refused; duplicate JPEG publication; failed-manifest save incorrectly counted;
missing CLI; missing run integration; failed-save association incorrectly claimed;
metadata leak/mutation; invalid observation metadata; junction escape; partial
bundle missing its manifest; missing writable systemd evidence configuration;
and silently skipped unreadable budget scan. The corresponding targeted tests
were rerun after each implementation change. This is deterministic contract and
filesystem coverage, not model-quality or Pi-performance validation.

The heartbeat suite also reproduced and fixed storage-error recovery after a
negative/no-op recorder sample, cadence accumulating request duration, the largest
supported interval colliding with server expiry, and terminal failures stopping
without a final status attempt. It verifies actual agent/recorder behavior and
the owned serial HTTP sender, not a Python reimplementation of cloud logic.
The interval maximum is 30 seconds; storage recovery requires a new indexed JPEG;
terminal failure delivery remains best effort with bounded shutdown.

Parent actual-workerd controls acceptance passed all 15 assertions after the
review fixes, including a real offline alarm at 60,019 ms and exact persisted
health/history/recovery/review read-back. The injected detections and empty native
response are explicitly synthetic. Current result:
`C:/Users/moihammed/AppData/Local/hermes/cache/scratch/operator-runtime-QQ0TAg/result.json`.
See `docs/operator-workflows.md` for rerun instructions and activation boundaries.

## Retained synthetic replay artifact

Exact command used (the detector is explicitly an injected synthetic fixture,
not local model inference or a real incident):

```sh
.venv/Scripts/python.exe -c 'import cv2, numpy as np, os, json, tempfile; from pathlib import Path; from edge.agent import parse_args, run; root=Path(tempfile.mkdtemp(prefix="fire-evidence-verification-", dir=Path(os.environ["LOCALAPPDATA"])/"hermes/cache/scratch")); video=root/"synthetic-source.avi"; writer=cv2.VideoWriter(str(video),cv2.VideoWriter_fourcc(*"MJPG"),1.0,(32,24)); assert writer.isOpened(); [writer.write(np.full((24,32,3),i*5,np.uint8)) for i in range(16)]; writer.release(); count=iter(range(16)); detector=lambda image: [{"cls":"smoke","conf":0.08,"bbox_xyxy":[1,2,10,12]}] if next(count)==5 else []; args=parse_args(["--video",str(video),"--camera","fixture","--dry-run","--fps","1","--start-ts-ms","1000000","--evidence-dir",str(root/"evidence"),"--report",str(root/"report.json")],environ={}); code,report=run(args,detector=detector); manifests=list((root/"evidence").rglob("manifest.json")); assert code==0 and len(manifests)==1; manifest=json.loads(manifests[0].read_text()); assert manifest["state"]=="tail_complete" and len(manifest["frames"])==14; images=[cv2.imread(str(manifests[0].parent/f["file"])) for f in manifest["frames"]]; assert all(im is not None and list(im.shape[:2])==[24,32] for im in images); print(json.dumps({"artifact_root":str(root),"manifest":str(manifests[0]),"exit_code":code,"sampled":report["frames_sampled"],"saved_frames":report["evidence"]["saved_frames"],"state":manifest["state"],"fixture_detector":"injected deterministic synthetic; not model inference"},indent=2))'
```

Observed result:

- Artifact root: `C:/Users/moihammed/AppData/Local/hermes/cache/scratch/fire-evidence-verification-zw7izxsi`
- Manifest: `evidence/cam-fixture/incident-0000001005000/manifest.json`
- Final report: `report.json`; decoded source: `synthetic-source.avi`.
- Exit **0**, sampled **16**, saved/indexed JPEGs **14**, state `tail_complete`.
- All 14 retained JPEGs were read back and decoded as 24x32 images.
- Scratch artifacts are only a development fixture and may be pruned by the
  Hermes scratch-cache lifecycle. Production `--evidence-dir` is not that cache
  and the recorder never prunes retained incidents.

No external network/model download, deployment, Git initialization, or commit was
performed. Existing HTTP contract tests use loopback only. systemd configuration
was checked by a static test, not started or validated on Linux/Pi hardware.
Real-video/local-YOLO and loopback-Worker integration are separate parent-run
verification layers; the CLI supports the required `--evidence-dir` argument.
