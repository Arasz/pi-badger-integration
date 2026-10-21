# MiniCPM-V 4.7 research moved

The MiniCPM-V 4.7 records — the MTPLX format, the 1B conversion, the runtime
formats, and the DSpark measurements — live in their own repository now:

**`/Users/arasz/RiderProjects/models-conversion`** (a local git repository)

| What | Where it is now |
|---|---|
| The MTPLX runtime contract for MiniCPM-V 4.7, and DSpark measured | `docs/work/2026-10-21-minicpmv-4-7-mtplx-format-and-dspark.md` |
| What MTPLX's artifact format is, and why the multimodal checkpoint is refused | `docs/work/2026-10-20-mtplx-format-for-minicpmv.md` |
| The 1B MLX conversion, and the runnable conversion scripts | `docs/work/2026-10-20-minicpmv-4-7-1b-kit/` |
| Which runtime takes which format (MLX, llama.cpp, GGUF) | `docs/work/2026-10-20-minicpmv-4-7-1b-runtime-formats.md` |
| The model overview (architectures, licences, format support) | `docs/reference/minicpm-v4.7-overview.md` |

The model artifacts themselves are built in that repository too, under `models/`:
the 35B-A3B's GGUF set and the DSpark drafts (for llama.cpp), and the 1B's MLX
conversions. The 35B-A3B's MTPLX artifact was built and measured there and then
removed — 20.9 GiB of weights that a 24 GB Mac cannot run; the record of the build
is worth more than the file, and the commands to rebuild it are in that
repository's README.

This repository keeps the ai-badger and pi extension work it was built for; the
model work moved with its own records.
