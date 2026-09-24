#!/usr/bin/env python3
"""Write a tiny random-weight model for test-in-fedora.sh --model.

    pip install gguf numpy
    ./make-test-model.py test-model.gguf

A Llama-architecture GGUF under 1 MB: two layers, 64-wide, random weights. It
generates nonsense, which is the point. Loading and running it exercises what a
packaging test can get wrong -- the engine's shared libraries, its CPU backends
(loaded at runtime), OpenMP, the tokenizer, sampling, and GobboNet's supervisor
starting the engine -- with no model download.

Two constraints, both found the hard way:
  - attention heads are 32 wide, because GobboNet runs a q8_0 KV cache and its
    blocks are 32 wide ("K cache type q8_0 with block size 32 does not divide
    n_embd_head_k=16");
  - the vocabulary has no byte tokens, only printable ASCII, newline and the
    word-start marker. With byte tokens the random weights emit broken UTF-8,
    and llama-server rejects the reply.

TEST SCAFFOLDING. Never shipped in a package.
"""
import sys

import gguf
import numpy as np

out = sys.argv[1] if len(sys.argv) > 1 else "test-model.gguf"
rng = np.random.default_rng(1234)

n_embd, n_layer, n_head, n_ff, n_ctx = 64, 2, 2, 128, 512   # head size 64 / 2 = 32

tokens, scores, types = [], [], []


def add(tok, score, typ):
    tokens.append(tok)
    scores.append(score)
    types.append(typ)


add("<unk>", 0.0, gguf.TokenType.UNKNOWN)
add("<s>", 0.0, gguf.TokenType.CONTROL)
add("</s>", 0.0, gguf.TokenType.CONTROL)
add("▁", -1.0, gguf.TokenType.NORMAL)          # SentencePiece word start
add("\n", -1.5, gguf.TokenType.NORMAL)
for i, c in enumerate(range(33, 127)):               # printable ASCII
    add(chr(c), -2.0 - i * 0.01, gguf.TokenType.NORMAL)
for i, ch in enumerate("abcdefghijklmnopqrstuvwxyz"):
    add("▁" + ch, -3.0 - i * 0.01, gguf.TokenType.NORMAL)
n_vocab = len(tokens)

w = gguf.GGUFWriter(out, "llama")
w.add_name("gobbonet-test-model")
w.add_context_length(n_ctx)
w.add_embedding_length(n_embd)
w.add_block_count(n_layer)
w.add_feed_forward_length(n_ff)
w.add_head_count(n_head)
w.add_head_count_kv(n_head)
w.add_layer_norm_rms_eps(1e-5)
w.add_rope_dimension_count(n_embd // n_head)
w.add_file_type(gguf.LlamaFileType.ALL_F32)
w.add_tokenizer_model("llama")
w.add_token_list(tokens)
w.add_token_scores(scores)
w.add_token_types(types)
w.add_unk_token_id(0)
w.add_bos_token_id(1)
w.add_eos_token_id(2)
w.add_add_bos_token(True)
w.add_add_eos_token(False)
w.add_chat_template(
    "{% for m in messages %}<|im_start|>{{ m['role'] }}\n{{ m['content'] }}<|im_end|>\n{% endfor %}"
    "{% if add_generation_prompt %}<|im_start|>assistant\n{% endif %}")


def t(*shape, scale=0.02):
    return (rng.standard_normal(shape) * scale).astype(np.float32)


w.add_tensor("token_embd.weight", t(n_vocab, n_embd))
w.add_tensor("output_norm.weight", np.ones(n_embd, dtype=np.float32))
w.add_tensor("output.weight", t(n_vocab, n_embd))
for i in range(n_layer):
    p = f"blk.{i}."
    w.add_tensor(p + "attn_norm.weight", np.ones(n_embd, dtype=np.float32))
    w.add_tensor(p + "attn_q.weight", t(n_embd, n_embd))
    w.add_tensor(p + "attn_k.weight", t(n_embd, n_embd))
    w.add_tensor(p + "attn_v.weight", t(n_embd, n_embd))
    w.add_tensor(p + "attn_output.weight", t(n_embd, n_embd))
    w.add_tensor(p + "ffn_norm.weight", np.ones(n_embd, dtype=np.float32))
    w.add_tensor(p + "ffn_gate.weight", t(n_ff, n_embd))
    w.add_tensor(p + "ffn_up.weight", t(n_ff, n_embd))
    w.add_tensor(p + "ffn_down.weight", t(n_embd, n_ff))

w.write_header_to_file()
w.write_kv_data_to_file()
w.write_tensors_to_file()
w.close()
print(f"wrote {out}: vocab {n_vocab}, {n_layer} layers, n_embd {n_embd}")
