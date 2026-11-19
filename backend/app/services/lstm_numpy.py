"""PyTorch-free LSTM inference.

The API only needs a forward pass, so it runs the trained weights with NumPy.
That keeps PyTorch (> 500 MB on Linux) out of the deployed API bundle, while
training — which needs autograd — still uses PyTorch in the worker.

This reproduces ``torch.nn.LSTM(input_size=1, hidden, num_layers, batch_first=True)``
followed by ``nn.Linear(hidden, 1)`` on the last time step, using PyTorch's
gate order (input, forget, cell, output):

    i = σ(W_ii x + b_ii + W_hi h + b_hi)      f = σ(W_if x + b_if + W_hf h + b_hf)
    g = tanh(W_ig x + b_ig + W_hg h + b_hg)   o = σ(W_io x + b_io + W_ho h + b_ho)
    c' = f ⊙ c + i ⊙ g                        h' = o ⊙ tanh(c')

Equivalence with PyTorch is checked in tests/test_forecasting.py.
"""
from __future__ import annotations

import io

import numpy as np

WEIGHTS_FORMAT = "npz-v1"


class LegacyWeightsFormatError(ValueError):
    """Weights were saved with torch.save(), and PyTorch is not installed here."""


def _sigmoid(x: np.ndarray) -> np.ndarray:
    # Numerically stable logistic function.
    out = np.empty_like(x)
    pos = x >= 0
    out[pos] = 1.0 / (1.0 + np.exp(-x[pos]))
    ex = np.exp(x[~pos])
    out[~pos] = ex / (1.0 + ex)
    return out


class NumpyLSTM:
    """Forward pass of the WCO LSTM from a state_dict of NumPy arrays."""

    def __init__(self, arrays: dict[str, np.ndarray]):
        self.layers = []
        k = 0
        while f"lstm.weight_ih_l{k}" in arrays:
            self.layers.append(tuple(np.asarray(arrays[f"lstm.{n}_l{k}"], dtype=np.float64) for n in
                                     ("weight_ih", "weight_hh", "bias_ih", "bias_hh")))
            k += 1
        if not self.layers:
            raise ValueError("weights contain no LSTM layers")
        self.fc_w = np.asarray(arrays["fc.weight"], dtype=np.float64)   # (1, H)
        self.fc_b = np.asarray(arrays["fc.bias"], dtype=np.float64)     # (1,)
        self.hidden_size = self.layers[0][1].shape[1]

    def predict_next(self, windows: np.ndarray) -> np.ndarray:
        """windows: (n, seq_len) scaled values → (n,) next scaled value."""
        x = np.asarray(windows, dtype=np.float64)[:, :, None]          # (n, T, 1)
        n, T, _ = x.shape
        seq = x
        for w_ih, w_hh, b_ih, b_hh in self.layers:
            h = np.zeros((n, self.hidden_size))
            c = np.zeros((n, self.hidden_size))
            outs = np.empty((n, T, self.hidden_size))
            pre_x = seq @ w_ih.T + b_ih + b_hh                           # (n, T, 4H)
            for t in range(T):
                gates = pre_x[:, t, :] + h @ w_hh.T
                i, f, g, o = np.split(gates, 4, axis=1)
                c = _sigmoid(f) * c + _sigmoid(i) * np.tanh(g)
                h = _sigmoid(o) * np.tanh(c)
                outs[:, t, :] = h
            seq = outs
        return (seq[:, -1, :] @ self.fc_w.T + self.fc_b)[:, 0]


def serialize_weights(state_dict: dict) -> bytes:
    """Store a (torch or NumPy) state_dict as a portable NPZ archive."""
    arrays = {}
    for k, v in state_dict.items():
        arrays[k] = v.detach().cpu().numpy() if hasattr(v, "detach") else np.asarray(v)
    buf = io.BytesIO()
    np.savez(buf, **{k: a.astype(np.float32) for k, a in arrays.items()})
    return buf.getvalue()


def deserialize_weights(data: bytes) -> dict[str, np.ndarray]:
    """Load NPZ weights; fall back to a legacy torch.save() blob if torch is installed."""
    # torch.save() output is also a zip archive, so check the contents, not just the magic.
    try:
        with np.load(io.BytesIO(data), allow_pickle=False) as z:
            arrays = {k: z[k] for k in z.files}
        if "fc.weight" in arrays and all(isinstance(a, np.ndarray) for a in arrays.values()):
            return arrays
    except Exception:
        pass
    try:
        import torch  # legacy format only
    except ImportError as e:  # API deployments don't ship torch
        raise LegacyWeightsFormatError(
            "weights are in the legacy PyTorch format; retrain to convert them") from e
    sd = torch.load(io.BytesIO(data), map_location="cpu", weights_only=True)
    return {k: v.numpy() for k, v in sd.items()}
