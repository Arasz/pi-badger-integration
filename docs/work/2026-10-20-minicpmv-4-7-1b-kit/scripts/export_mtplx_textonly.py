#!/usr/bin/env python3
"""Export a MiniCPM-V 4.7 MLX checkpoint as a text-only Qwen3.5 model MTPLX can load.

MTPLX's loader resolves the checkpoint's top-level `model_type` against mlx-lm's module
registry, so `minicpmv4_7` is rejected ("ValueError: Model type minicpmv4_7 not supported").
MiniCPM-V 4.7's text tower is a Qwen3.5 text model (`text_config.model_type == "qwen3_5_text"`),
and mlx-lm's `qwen3_5` module matches it tensor-for-tensor while its `Model.sanitize` skips
`vision_tower.*`.

So: keep the `language_model.*` tensors, drop the vision/merger ones, and rewrite config.json
with `model_type: qwen3_5` and the original `text_config`.

The result runs in MTPLX autoregressively (no vision, no speculative decoding) and in mlx-lm.
Evidence: docs/work/2026-10-20-mtplx-format-for-minicpmv.md.

Usage:
    python export_mtplx_textonly.py <src-mlx-dir> <dst-dir>

Requires: mlx (mx.load / mx.save_safetensors do the work; numpy is not needed).
"""

from __future__ import annotations

import json
import os
import shutil
import sys

import mlx.core as mx

KEEP_PREFIX = "language_model."
TOKENIZER_FILES = (
    "tokenizer.json",
    "tokenizer_config.json",
    "generation_config.json",
    "chat_template.jinja",
)


def _load_weights(src: str) -> dict:
    """Load a checkpoint's weights, single-file or sharded.

    A 1B conversion is one `model.safetensors`; the 35B-A3B ones are sharded and carry a
    `model.safetensors.index.json` naming the shard files.
    """
    index_path = os.path.join(src, "model.safetensors.index.json")
    if os.path.isfile(index_path):
        index = json.load(open(index_path))
        shards = sorted(set(index["weight_map"].values()))
        merged: dict = {}
        for shard in shards:
            merged.update(mx.load(os.path.join(src, shard)))
        print(f"source: {len(shards)} shards ({', '.join(shards)})")
        return merged
    return mx.load(os.path.join(src, "model.safetensors"))


def _source_bytes(src: str) -> int:
    """Total bytes of the source checkpoint's weight files."""
    index_path = os.path.join(src, "model.safetensors.index.json")
    if os.path.isfile(index_path):
        index = json.load(open(index_path))
        return sum(
            os.path.getsize(os.path.join(src, shard))
            for shard in sorted(set(index["weight_map"].values()))
        )
    return os.path.getsize(os.path.join(src, "model.safetensors"))


def _human(n: int) -> str:
    """A size in both units the records use: GiB and decimal MB."""
    if n >= 2**30:
        return f"{n / 2**30:.2f} GiB ({n / 1e6:.2f} MB)"
    if n >= 1e6:
        return f"{n / 1e6:.2f} MB"
    return f"{n / 1e3:.1f} kB"


def fail(message: str) -> "None":
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def export(src: str, dst: str) -> None:
    config_path = os.path.join(src, "config.json")
    weights_path = os.path.join(src, "model.safetensors")
    index_path = os.path.join(src, "model.safetensors.index.json")
    if not os.path.isfile(config_path):
        fail(f"{src} has no config.json — point this at a converted MLX checkpoint")
    if not os.path.isfile(weights_path) and not os.path.isfile(index_path):
        fail(
            f"{src} has no model.safetensors (nor a sharded index) — point this at a "
            "converted MLX checkpoint"
        )

    config = json.load(open(config_path))
    text_config = config.get("text_config")
    if not text_config:
        fail(f"{src}/config.json has no text_config — this export needs a multimodal MiniCPM config")

    os.makedirs(dst, exist_ok=True)

    weights = _load_weights(src)
    kept = {k: v for k, v in weights.items() if k.startswith(KEEP_PREFIX)}
    dropped = len(weights) - len(kept)
    print(f"tensors: kept {len(kept)}, dropped {dropped} (vision/merger)")
    if not kept:
        fail(f"no {KEEP_PREFIX} tensors in {src} — is this really a MiniCPM-V checkpoint?")

    mx.save_safetensors(os.path.join(dst, "model.safetensors"), kept)

    quantization = config.get("quantization") or config.get("quantization_config")
    new_config = {
        "architectures": ["Qwen3_5ForCausalLM"],
        "model_type": "qwen3_5",
        "text_config": text_config,
        "dtype": config.get("dtype", "bfloat16"),
        "tie_word_embeddings": text_config.get("tie_word_embeddings", False),
    }
    if quantization:
        new_config["quantization"] = quantization
    for key in ("eos_token_id", "bos_token_id", "pad_token_id"):
        if key in config:
            new_config[key] = config[key]
    json.dump(new_config, open(os.path.join(dst, "config.json"), "w"), indent=2)

    copied = []
    for name in TOKENIZER_FILES:
        source = os.path.join(src, name)
        if os.path.exists(source):
            shutil.copy2(source, os.path.join(dst, name))
            copied.append(name)

    src_bytes = _source_bytes(src)
    dst_bytes = os.path.getsize(os.path.join(dst, "model.safetensors"))
    print(f"wrote {dst}")
    print(f"  weights {_human(src_bytes)} -> {_human(dst_bytes)}")
    print(f"  config model_type=qwen3_5, text_config carried over, quantization: {quantization}")
    print(f"  tokenizer files: {', '.join(copied) if copied else 'none found'}")
    print("next: mtplx run --model %s --prompt 'hi' --reasoning off" % dst)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        raise SystemExit(2)
    export(sys.argv[1], sys.argv[2])
