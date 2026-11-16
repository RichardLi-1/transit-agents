"""A chunked gated delta rule for training Qwen3.5 with mlx-lm on long sequences.

Qwen3.5 is a hybrid: three of every four layers are Gated DeltaNet (linear attention).
In training mode mlx-lm runs their recurrence as a Python loop over every token
(models/gated_delta.py, gated_delta_ops), whose backward pass keeps a [heads, 128, 128]
state for each token: about 2 MB a token a layer, so a 4,000-token trajectory needs
8 GB for one layer. This computes the same thing chunk by chunk, as the flash-linear-
attention project's reference chunk algorithm does: parallel within a chunk of 64
tokens, sequential across chunks, so backward keeps one state a chunk.

Only training uses it (the layer's `use_kernel` is False): inference keeps mlx-lm's
Metal kernel. tests/test_sft.py checks it against mlx-lm's own loop, values and
gradients. Import and call patch() before training.
"""

import mlx.core as mx
import mlx.nn as nn

CHUNK = 64


def gated_delta_chunked(q, k, v, a, b, A_log, dt_bias, state=None, chunk: int = CHUNK):
    """y and the final state, as mlx-lm's gated_delta_update gives them.

    q, k: [B, T, Hk, Dk], already normalised (the readout scale folded into q);
    v: [B, T, Hv, Dv]; a, b: [B, T, Hv]; state: [B, Hv, Dv, Dk] or None.
    """
    B, T, Hk, Dk = q.shape
    Hv, Dv = v.shape[-2:]
    dtype = q.dtype
    beta = mx.sigmoid(b.astype(mx.float32))
    log_g = -mx.exp(A_log.astype(mx.float32)) * nn.softplus((a + dt_bias).astype(mx.float32))
    if (repeat := Hv // Hk) > 1:
        q = mx.repeat(q, repeat, -2)
        k = mx.repeat(k, repeat, -2)
    # [B, H, T, D], in float32
    q, k, v = (x.astype(mx.float32).transpose(0, 2, 1, 3) for x in (q, k, v))
    beta, log_g = (x.transpose(0, 2, 1) for x in (beta, log_g))
    pad = (-T) % chunk
    if pad:
        q, k, v = (mx.pad(x, [(0, 0), (0, 0), (0, pad), (0, 0)]) for x in (q, k, v))
        beta, log_g = (mx.pad(x, [(0, 0), (0, 0), (0, pad)]) for x in (beta, log_g))
    n = (T + pad) // chunk
    q, k, v = (x.reshape(B, Hv, n, chunk, x.shape[-1]) for x in (q, k, v))
    beta = beta.reshape(B, Hv, n, chunk)
    G = mx.cumsum(log_g.reshape(B, Hv, n, chunk), axis=-1)  # log of the decay since the chunk began

    rows = mx.arange(chunk)
    lower = rows[:, None] >= rows[None, :]
    strict = rows[:, None] > rows[None, :]
    # exp(G_i - G_j) for j <= i, else 0, without exp of the (positive) upper triangle
    L = mx.exp(mx.where(lower, G[..., :, None] - G[..., None, :], -mx.inf))

    k_beta = k * beta[..., None]
    N = mx.where(strict, -(k_beta @ k.swapaxes(-1, -2)) * L, 0.0)
    # (I - N)^-1 for strictly lower N, by forward substitution, row by row, as the
    # reference does: a product of powers of N overflows when keys repeat.
    rows = [N[..., 0, :]]
    for i in range(1, chunk):
        done = mx.stack(rows, axis=-2)  # [..., i, C]
        rows.append(N[..., i, :] + (N[..., i : i + 1, :i] @ done)[..., 0, :])
    X = mx.stack(rows, axis=-2) + mx.eye(chunk)
    W = X @ (k_beta * mx.exp(G)[..., None])  # [B, H, n, C, Dk]
    U = X @ (v * beta[..., None])  # [B, H, n, C, Dv]

    M = mx.zeros((B, Hv, Dk, Dv), dtype=mx.float32) if state is None else state.astype(mx.float32).swapaxes(-1, -2)
    out = []
    for i in range(n):
        q_i, k_i, G_i = q[:, :, i], k[:, :, i], G[:, :, i]
        attn = (q_i @ k_i.swapaxes(-1, -2)) * L[:, :, i]
        v_new = U[:, :, i] - W[:, :, i] @ M
        out.append((q_i * mx.exp(G_i)[..., None]) @ M + attn @ v_new)
        last = G_i[..., -1:]
        M = M * mx.exp(last)[..., None] + (k_i * mx.exp(last - G_i)[..., None]).swapaxes(-1, -2) @ v_new
    y = mx.concatenate(out, axis=2)[:, :, :T].transpose(0, 2, 1, 3)
    return y.astype(dtype), M.swapaxes(-1, -2)


def patch() -> None:
    """Have Qwen3.5's (and Qwen3-Next's) linear attention use the chunked rule in training."""
    from mlx_lm.models import gated_delta, qwen3_5

    original = gated_delta.gated_delta_update

    def update(q, k, v, a, b, A_log, dt_bias, state=None, mask=None, *, use_kernel=True, lower_bound=None, allow_neg_eigval=False):
        if use_kernel or mask is not None or lower_bound is not None or allow_neg_eigval:
            return original(
                q, k, v, a, b, A_log, dt_bias, state, mask,
                use_kernel=use_kernel, lower_bound=lower_bound, allow_neg_eigval=allow_neg_eigval,
            )
        return gated_delta_chunked(q, k, v, a, b, A_log, dt_bias, state)

    qwen3_5.gated_delta_update = update
