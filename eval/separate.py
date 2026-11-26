# Research only (eval/README.md, "Overlapped speech"): separate the overlap regions of a recording into two streams.
# Needs a throwaway Python venv: pip install torch torchaudio soundfile speechbrain clearvoice. Not used by the app.
# usage: separate.py MODEL wav regions.json outdir [--pad 0.5] [--device cpu|cuda] [--threads N]
import sys, json, os, time, argparse
import numpy as np, soundfile as sf, torch
ap = argparse.ArgumentParser()
ap.add_argument('model'); ap.add_argument('wav'); ap.add_argument('regions'); ap.add_argument('out')
ap.add_argument('--pad', type=float, default=0.5); ap.add_argument('--device', default='cpu'); ap.add_argument('--threads', type=int, default=8)
ap.add_argument('--key', default='D'); ap.add_argument('--savedir', default=None)
a = ap.parse_args()
a.wav, a.regions, a.out = map(os.path.abspath, (a.wav, a.regions, a.out))
torch.set_num_threads(a.threads)
x, sr = sf.read(a.wav, dtype='float32'); assert sr == 16000
regs = json.load(open(a.regions))[a.key]
# pad and merge
pr = []
for s, e in sorted(regs):
    s, e = max(0, s - a.pad), min(len(x) / sr, e + a.pad)
    if pr and s <= pr[-1][1]: pr[-1][1] = max(pr[-1][1], e)
    else: pr.append([s, e])
os.makedirs(a.out, exist_ok=True)
if a.model.startswith('sb:'):
    from speechbrain.inference.separation import SepformerSeparation
    m = SepformerSeparation.from_hparams(source=a.model[3:], savedir=a.savedir, run_opts={'device': a.device})
    msr = m.hparams.sample_rate if hasattr(m.hparams, 'sample_rate') else 8000
    def sep(seg):
        import torchaudio
        t = torch.from_numpy(seg)[None]
        if msr != 16000: t = torchaudio.functional.resample(t, 16000, msr)
        with torch.no_grad(): y = m.separate_batch(t.to(a.device))[0].T.cpu()  # [spk, T]
        if msr != 16000: y = torchaudio.functional.resample(y, msr, 16000)
        return y.numpy()
elif a.model.startswith('cv:'):
    import tempfile
    os.chdir(a.savedir)  # ClearVoice keeps its checkpoints under ./checkpoints
    from clearvoice import ClearVoice
    cv = ClearVoice(task='speech_separation', model_names=[a.model[3:]])
    if a.device == 'cpu':
        for m in cv.models: m.model.to('cpu'); m.device = torch.device('cpu'); m.args.use_cuda = 0
    tmp = os.path.join(tempfile.mkdtemp(), 'seg.wav')
    def sep(seg):
        sf.write(tmp, seg, 16000)
        y = cv(input_path=tmp, online_write=False)
        return np.stack([np.asarray(c).reshape(-1) for c in y])
else:
    raise SystemExit('unknown model ' + a.model)
meta, t0 = [], time.time()
for k, (s, e) in enumerate(pr):
    seg = x[int(s * sr):int(e * sr)]
    t1 = time.time(); y = sep(seg); dt = time.time() - t1
    rms = np.sqrt((seg ** 2).mean()) + 1e-8
    files = []
    for j, ch in enumerate(y):
        ch = ch[:len(seg)]
        ch = ch / (np.sqrt((ch ** 2).mean()) + 1e-8) * rms  # same loudness as the mix
        ch = np.clip(ch, -1, 1)
        f = os.path.join(a.out, f'r{k:03d}_s{j}.wav'); sf.write(f, ch, 16000, subtype='PCM_16'); files.append(f)
    meta.append({'start': s, 'end': e, 'files': files, 'sec': dt})
json.dump({'regions': meta, 'total': time.time() - t0, 'audio': sum(e - s for s, e in pr)}, open(os.path.join(a.out, 'meta.json'), 'w'), indent=1)
print('regions', len(pr), 'audio s', round(sum(e - s for s, e in pr), 1), 'sep s', round(time.time() - t0, 1))
