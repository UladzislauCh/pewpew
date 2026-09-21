"""Temporal model: the clip as a series, not as a set of windows around audio candidates.

WHY. Everything measured in the project so far decided "is this audio candidate an own shot or
not". That framing has a recall ceiling of 85.5%: in a dense burst several shots get ONE
candidate, and a filter cannot separate them in principle. A model over time is free to place an
event where there was no candidate.

The convolution is one-dimensional and small — not out of modesty but by measurement: the
project journal showed that on 49 clips capacity beyond a linear model hurts MONOTONICALLY (a
network with 8/24/48 neurons lost the more, the larger it was). Here capacity is needed for TIME,
not for a complex decision surface, so there are few channels and a wide receptive field.

Torch is used DELIBERATELY and only for training: the project rule forbids libraries on the path
that will ship in the product, but not in exploration. The network is portable — a 1-D
convolution, with a direct precedent in ShotNet, which lives in TypeScript without libraries and
whose weights arrive as plain JSON.

    python3 python/tools/temporal_train.py [--steps 2000] [--folds 5]
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import torch
from torch import nn

sys.path.insert(0, str(Path(__file__).resolve().parent))
import temporal_data as td  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
SEED = 20260827

#: Training crop length in samples (86.13 per second). Six seconds — well above the longest
#: burst, so the model sees it whole.
CROP = 512
BATCH = 24
FOLDS = 5
#: OPTIMISER STEPS, not passes over the data: each step is a batch of random crops.
#: The first run made 40 steps, and that was a warm-up, not training.
STEPS = 2000


class TemporalNet(nn.Module):
    """Three convolutions with growing dilation: a receptive field of ~660 ms at 24 channels.

    The receptive field is chosen so the model sees a whole BURST rather than a single shot:
    unseparated bursts are exactly what holds the recall ceiling.
    """

    def __init__(self, channels: int) -> None:
        super().__init__()
        self.net = nn.Sequential(
            nn.Conv1d(channels, 24, 9, padding=4),
            nn.ReLU(),
            nn.Conv1d(24, 24, 9, padding=8, dilation=2),
            nn.ReLU(),
            nn.Conv1d(24, 24, 9, padding=16, dilation=4),
            nn.ReLU(),
            nn.Conv1d(24, 1, 1),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x).squeeze(1)


def fold_of(clips: list[str], folds: int) -> dict[str, int]:
    """Folds BY CLIP: within a clip samples are not independent, and splitting them apart would
    measure peeking."""
    return {slug: i % folds for i, slug in enumerate(clips)}


def degrade(d: dict, jitter_ms: float, drop: float, rng: np.random.Generator) -> np.ndarray:
    """Corrupt the TRAINING target the way manual labelling corrupts it.

    We check exactly one question: does label jitter hurt the model. The labels for EVALUATION
    stay real — otherwise we would be measuring agreement with noise, not quality.
    """
    rate = d['rate']
    y = np.zeros(len(d['y']), dtype=np.float32)
    for shot in d['shots']:
        if drop and rng.random() < drop:
            continue
        t = shot + rng.normal(0.0, jitter_ms / 1000.0)
        c = int(round(t * rate))
        y[max(0, c - td.TARGET_HALF):min(len(y), c + td.TARGET_HALF + 1)] = 1.0
    return y


def train_fold(train: list[str], steps: int, keep: list[int],
               jitter_ms: float = 0.0, drop: float = 0.0) -> tuple[nn.Module, np.ndarray, np.ndarray]:
    data = [td.load(s) for s in train]
    stack = np.concatenate([d['x'][:, keep] for d in data])
    mean, std = stack.mean(axis=0), stack.std(axis=0)
    std[std < 1e-6] = 1.0

    pos = sum(float(d['y'].sum()) for d in data)
    total = sum(len(d['y']) for d in data)
    pos_weight = torch.tensor([(total - pos) / max(1.0, pos)], dtype=torch.float32)

    torch.manual_seed(SEED)
    model = TemporalNet(len(keep))
    opt = torch.optim.Adam(model.parameters(), lr=2e-3)
    loss_fn = nn.BCEWithLogitsLoss(pos_weight=pos_weight)
    rng = np.random.default_rng(SEED)

    xs = [((d['x'][:, keep] - mean) / std).T.astype(np.float32) for d in data]
    if jitter_ms or drop:
        noise = np.random.default_rng(SEED)
        ys = [degrade(d, jitter_ms, drop, noise) for d in data]
    else:
        ys = [d['y'].astype(np.float32) for d in data]

    model.train()
    for _ in range(steps):
        bx, by = [], []
        for _ in range(BATCH):
            i = rng.integers(len(xs))
            t = xs[i].shape[1]
            if t <= CROP:
                pad = CROP - t
                bx.append(np.pad(xs[i], ((0, 0), (0, pad))))
                by.append(np.pad(ys[i], (0, pad)))
            else:
                o = int(rng.integers(t - CROP))
                bx.append(xs[i][:, o:o + CROP])
                by.append(ys[i][o:o + CROP])
        opt.zero_grad()
        out = model(torch.from_numpy(np.stack(bx)))
        loss = loss_fn(out, torch.from_numpy(np.stack(by)))
        loss.backward()
        opt.step()
    return model, mean, std


def predict(model: nn.Module, slug: str, mean: np.ndarray, std: np.ndarray, keep: list[int]) -> np.ndarray:
    d = td.load(slug)
    x = ((d['x'][:, keep] - mean) / std).T.astype(np.float32)[None]
    model.eval()
    with torch.no_grad():
        return torch.sigmoid(model(torch.from_numpy(x)))[0].numpy()


#: Clips whose labels a person reconciled with the ammo counter. Taken from HISTORY, not from
#: `labeledAt`: the relabelling did not update the date in the labels.
#:
#: `77b6d3b` — the first wave, 22 clips, episode by episode.
#: `9bf384a` — the second wave: nine clips where the counter is readable but the labels had stayed
#: manual. Two needed fixes, the other seven were CHECKED and found correct, so all nine go into
#: the checked set, not only the changed ones.
CHECKED_COMMITS = ('77b6d3b',)
CHECKED_EXTRA = (
    'donk-5100-elo-aim-429d5b23', 'g3sg1-c6efc1c9', 'mag7-9be72a14',
    'my-skills-in-cs2-are-incredible-c460aea8', 'nova-3b93ac4e', 'r8-revolver-4b824ff6',
    'sawedoff-4d0b1bb9', 'scar20-beca1553', 'ssg08-f176c0bd',
)


def checked() -> set[str]:
    out = set(CHECKED_EXTRA)
    for commit in CHECKED_COMMITS:
        names = subprocess.run(['git', 'show', '--name-only', '--format=', commit],
                               cwd=ROOT, capture_output=True, text=True, check=True).stdout
        out |= {n[len('labels/'):-len('.json')] for n in names.split('\n')
                if n.startswith('labels/') and n.endswith('.json')}
    return out


def select(clips: list[str], group: str) -> list[str]:
    """Clips by LABEL QUALITY.

    `clean` — those whose labels a person reconciled frame by frame with the ammo counter.
    `dirty` — the rest: labels were placed by ear and jitter by half a frame.

    SPLITTING BY "THE COUNTER IS READABLE" IS WRONG, although the temptation is great and one
    measurement in this branch already tripped over it. The sets do not coincide: nine readable
    clips stayed with manual labels, and four relabelled ones the counter does not read at all.
    Splitting by `covered` gave 18 against 24 and measured something other than promised.
    """
    if group == 'all':
        return clips
    good = checked()
    return [s for s in clips if (s in good) == (group == 'clean')]


def channel_mask(which: str) -> list[int]:
    """Which channels to give the model: `all`, `audio` (audio only), `video` (video only).

    Needed to separate the contribution of video from that of audio. Without it one cannot say
    whether the model fixes something new or just rediscovers ShotNet.
    """
    if which == 'audio':
        return [0]
    if which == 'video':
        return list(range(1, len(td.CHANNELS)))
    return list(range(len(td.CHANNELS)))


def main() -> None:
    steps = int(sys.argv[sys.argv.index('--steps') + 1]) if '--steps' in sys.argv else STEPS
    which = sys.argv[sys.argv.index('--channels') + 1] if '--channels' in sys.argv else 'all'
    keep = channel_mask(which)
    folds = int(sys.argv[sys.argv.index('--folds') + 1]) if '--folds' in sys.argv else FOLDS
    jitter = float(sys.argv[sys.argv.index('--jitter') + 1]) if '--jitter' in sys.argv else 0.0
    drop = float(sys.argv[sys.argv.index('--drop') + 1]) if '--drop' in sys.argv else 0.0
    group = sys.argv[sys.argv.index('--group') + 1] if '--group' in sys.argv else 'all'
    limit = int(sys.argv[sys.argv.index('--limit') + 1]) if '--limit' in sys.argv else 0
    clips = select(td.clips(), group)
    # Equalise the groups by size: without this the gap between "clean" and "dirty" labels could
    # be put down to one group having more clips. The sample is random, but with the same seed,
    # i.e. reproducible.
    if limit and limit < len(clips):
        clips = sorted(np.random.default_rng(SEED).choice(clips, limit, replace=False).tolist())
    channels = len(keep)
    assign = fold_of(clips, folds)
    note = f', порча меток: дрожание {jitter} мс, пропуск {drop:.0%}' if (jitter or drop) else ''
    print(f'клипов {len(clips)} ({group}), каналов {channels} ({which}), фолдов {folds}, шагов {steps}{note}')

    out = ROOT / 'python/out/temporalProb'
    out.mkdir(parents=True, exist_ok=True)
    for k in range(folds):
        train = [s for s in clips if assign[s] != k]
        test = [s for s in clips if assign[s] == k]
        model, mean, std = train_fold(train, steps, keep, jitter, drop)
        # We predict on TRAINING clips too: the threshold is chosen honestly on them, otherwise
        # it would be tuned on the same set we measure on.
        for slug in test:
            np.save(out / f'{slug}.npy', predict(model, slug, mean, std, keep))
        for slug in train:
            np.save(out / f'train-{k}-{slug}.npy', predict(model, slug, mean, std, keep))
        print(f'  фолд {k}: обучено на {len(train)}, предсказано {len(test)}', flush=True)
    (out / 'index.json').write_text(
        json.dumps({'clips': clips, 'channels': which, 'folds': assign}), encoding='utf-8')
    print(f'вероятности записаны в {out}')


if __name__ == '__main__':
    main()
