"""Exporting a trained YOLOv8 (`best.pt`) to ONNX for the browser.

WHY A FIXED INPUT. `dynamic=False` is not a whim: WebGPU in onnxruntime-web builds its plan for
specific shapes, and with dynamic axes it either falls back to wasm or rebuilds the graph on every
frame. For a per-frame run that is a difference of several times.

WHAT IS CHECKED AFTER EXPORT. The output shape and class names are printed and written next to the
model in `flashNet.meta.json`. The frontend reads the names from there rather than keeping its own
copy of the list: a second copy silently diverges from the first — the project has been burned by
this before.

    python3 python/tools/export_yolo.py --weights runs/detect/train/weights/best.pt
    python3 python/tools/export_yolo.py --weights best.pt --imgsz 640 --opset 12

Installed separately, does not ship in the product:  pip install ultralytics onnx onnxruntime
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
#: Where the model goes. The same directory as shotNet.json and ammoPrototypes.json:
#: `public/` is served statically, and the browser path becomes '/models/flashNet.onnx'.
DEST = ROOT / 'public/models'


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--weights', required=True, help='путь к best.pt')
    #: One number — a square. Two — HEIGHT and WIDTH, as ultralytics accepts them.
    #: A rectangular input removes the grey letterbox padding: for a vertical short it takes
    #: 44% of the square, and convolutions run over emptiness.
    ap.add_argument('--imgsz', type=int, nargs='+', default=[640])
    #: 12 is the widest for compatibility with onnxruntime-web. Go higher only if the export
    #: complains about an unsupported operation.
    ap.add_argument('--opset', type=int, default=12)
    ap.add_argument('--name', default='flashNet')
    ap.add_argument('--half', action='store_true',
                    help='fp16: вдвое меньше файл, но на wasm медленнее — проверяйте замером')
    args = ap.parse_args()

    from ultralytics import YOLO

    model = YOLO(args.weights)
    names = model.names if isinstance(model.names, dict) else dict(enumerate(model.names))

    imgsz = args.imgsz[0] if len(args.imgsz) == 1 else list(args.imgsz)
    path = Path(model.export(
        format='onnx',
        imgsz=imgsz,
        opset=args.opset,
        # NMS is left to the BROWSER. NMS built into the graph pulls in operations that WebGPU
        # lacks, and the whole model falls back to wasm entirely.
        nms=False,
        dynamic=False,
        simplify=True,
        half=args.half,
    ))

    DEST.mkdir(parents=True, exist_ok=True)
    onnx_path = DEST / f'{args.name}.onnx'
    shutil.copy(path, onnx_path)

    # The frontend needs the output shape so as not to guess the tensor layout.
    import onnxruntime as ort
    sess = ort.InferenceSession(str(onnx_path), providers=['CPUExecutionProvider'])
    inp, out = sess.get_inputs()[0], sess.get_outputs()[0]

    meta = {
        'imgsz': imgsz,
        'input': {'name': inp.name, 'shape': [d if isinstance(d, int) else -1 for d in inp.shape]},
        'output': {'name': out.name, 'shape': [d if isinstance(d, int) else -1 for d in out.shape]},
        'names': {str(k): v for k, v in names.items()},
    }
    (DEST / f'{args.name}.meta.json').write_text(json.dumps(meta, ensure_ascii=False, indent=1),
                                                 encoding='utf-8')

    size_mb = onnx_path.stat().st_size / 1e6
    print(f'{onnx_path}  {size_mb:.1f} МБ')
    print(f"вход  {inp.name}  {inp.shape}")
    print(f"выход {out.name}  {out.shape}   <- [1, 4+классов, якорей] у YOLOv8")
    print(f"классы: {names}")
    if size_mb > 25:
        print('\nВНИМАНИЕ: больше 25 МБ. В браузере это заметная задержка первого запуска.'
              '\n          Посмотрите на yolov8n вместо s/m, либо --half.')


if __name__ == '__main__':
    main()
